/**
 * Ensure Report Automation ("Generate report")
 *
 * Seeds THE report automation into a workspace: a MANUALLY-triggered, multi-round
 * AI flow that gathers real workspace state, interprets it across three AI rounds,
 * and materializes a `report` entity whose BODY is Synap-flavoured markdown.
 *
 * WHY THIS HOME (and not a workspace template):
 *   A workspace-template automation (`workspace-templates/*.yaml` → `flowAutomations`)
 *   only lands in workspaces provisioned FROM that template. This automation is not
 *   domain-specific — it is the pod-level "tell me what's going on here" verb, and it
 *   must exist in EVERY workspace including ones that predate it. That is exactly the
 *   contract `ensureDefaultCommands` / `ensureDefaultRelationDefs` implement: an
 *   idempotent, name-keyed reconcile that runs from the workspace-init worker for new
 *   workspaces AND from `workspaces.get` for existing ones. Same pattern, same file
 *   shape, same package (@synap/database, so both @synap/api and @synap/jobs can call
 *   it without a cycle).
 *
 * WHAT IT DEPENDS ON (all verified against the live engine, 2026-07-26):
 *   - `capability` nodes with `verbId: "ai.generate"` run SYNCHRONOUSLY through the
 *     capability router and return the model output DIRECTLY as `steps.<id>.output`
 *     (builtin-verbs.ts: `aiGenerateHandler` → `generateViaIS` → `data.output`).
 *     `ai.generate` is in READ_ONLY_BUILTIN_VERBS → auto-runs, no grant, no proposal.
 *     `maxTokens` is capped at 2000 by its zod schema.
 *   - `query` nodes read the workspace lens ∪ pod-wide rows, owner-floored
 *     (`entityQueryVisibilityWhere`). Deterministic — no LLM in the gather stage.
 *   - `continueOnError: true` records `{ error: "..." }` as that step's output and
 *     keeps walking the DAG; the default is FAIL-FAST.
 *   - The `entity_create` output node accepts `body?: string` (markdown) and
 *     materializes it into a `documents` row linked via `entities.documentId`.
 *   - `deepResolveTemplates` preserves the native value when the whole string is one
 *     `{{...}}` placeholder — which is why `body: "{{steps.assemble.output}}"` hands
 *     the assembler's markdown through unstringified.
 *
 * KNOWN LIMITS (deliberate, stated rather than papered over):
 *   - The `query` node has NO ordering clause, so "recent" is not expressible; the
 *     gather rounds sample up to `limit` rows of each kind. The prompts therefore say
 *     "a sample of", never "the latest".
 *   - `{{trigger.payload.projectId}}` / `.focus` narrow at the INTERPRETATION layer,
 *     not in SQL. The `query` node's `filter` treats an empty string as a real value
 *     (`properties->>'projectId' = ''`), so wiring the payload straight into `filter`
 *     would make the NO-payload run return zero rows. Narrowing lives in the prompts.
 *   - `reportPeriod` and the entity title carry the raw ISO timestamp from the
 *     `compute:now` node. No node in the engine can format a date ("July 2026",
 *     "2026-W30"), and inventing one in an AI round would make the header
 *     non-deterministic. Honest and ugly beats pretty and made up.
 *   - There is no digest-endpoint shortcut: `GET /workspaces/:id/digest` is Hub REST,
 *     and the only node that speaks HTTP (`fetch`) runs behind `validateExternalUrl`
 *     plus needs a service key it has no way to hold. Gather is `query` nodes.
 */

import { getDb } from "../client-pg.js";
import { automations, workspaces } from "../schema/index.js";
import type { FlowDefinition } from "../schema/automations.js";
import { and, eq } from "drizzle-orm";

/** Stable identity of the seeded automation — the reconcile key. */
export const REPORT_AUTOMATION_NAME = "Generate report";

/**
 * Definition version. BUMP THIS whenever `REPORT_AUTOMATION_FLOW` or the
 * description changes, so already-seeded workspaces pick the change up on their
 * next reconcile instead of being frozen at whatever shipped first.
 *
 * v2 — dogfood fix: `summarize` maxTokens 120 → 500. Verified against the live
 * IS that `ai.generate` returns an EMPTY STRING below ~200 tokens (the budget is
 * consumed before the first visible token), so a low cap yields NO answer rather
 * than a short one — and the step still reports success.
 */
export const REPORT_AUTOMATION_SEED_VERSION = 2;

export const REPORT_AUTOMATION_DESCRIPTION =
  "Gather this workspace's state, interpret it over three AI rounds, and write a " +
  "report entity. Run it as-is for a general report, or pass a prompt " +
  '(e.g. "focus on our clients") to steer what it is about.';

// ── Shared prompt fragments ───────────────────────────────────────────────────
//
// THE OVERRIDE MECHANISM, in one place so every round behaves identically:
// each round's user prompt opens with a STEER block whose three lines interpolate
// the trigger payload. With no payload those placeholders resolve to the EMPTY
// STRING (`resolveTemplate` returns "" for a missing path), so the block renders as
// three bare labels — and every system prompt is told, explicitly, that an empty
// steer means "produce a broad general report". With a payload the same three lines
// carry real text and the system prompt is told to treat it as the report's SUBJECT,
// not as decoration: prioritize matching evidence, name what was de-prioritized, and
// say plainly when the gathered data cannot support the steer.

const STEER_BLOCK = [
  "STEER (may be empty — an empty line means no steer was given):",
  "- Prompt: {{trigger.payload.prompt}}",
  "- Focus: {{trigger.payload.focus}}",
  "- Project lens id: {{trigger.payload.projectId}}",
].join("\n");

const STEER_RULE =
  "STEER HANDLING — non-negotiable. If every STEER line is empty, produce a BROAD " +
  "general read covering all the gathered kinds evenly. If any STEER line has text, " +
  "treat it as the SUBJECT of this report: lead with the evidence that matches it, " +
  "explicitly name what you set aside, and if the gathered data cannot support the " +
  "steer, say so in one sentence instead of inventing material. Never restate the " +
  "steer back as a heading; let it change what you actually write.";

const EVIDENCE_RULE =
  "You are interpreting data you did NOT collect. Every claim must trace to a row " +
  "in the GATHERED DATA below. Never invent entities, ids, counts, or dates. " +
  'A step whose value looks like {"error": "..."} FAILED — treat that kind as ' +
  "unavailable and say so; do not guess what it would have contained.";

/** The gathered-data block every AI round receives, verbatim. */
const GATHERED_DATA = [
  "GATHERED DATA (a sample, not an ordered or exhaustive listing):",
  "Tasks: {{steps.gather-tasks.output}}",
  "Notes: {{steps.gather-notes.output}}",
  "People: {{steps.gather-people.output}}",
  "Companies: {{steps.gather-companies.output}}",
].join("\n");

// ── Round system prompts ──────────────────────────────────────────────────────

const ANALYZE_SYSTEM = [
  "You are the ANALYST round of a Synap workspace report.",
  "Read the gathered workspace data and say what it MEANS: volume and shape of work,",
  "what is in flight versus stalled, what is well-covered versus thin.",
  EVIDENCE_RULE,
  STEER_RULE,
  "Output PLAIN PROSE — short paragraphs and bullets. No markdown headings, no",
  "directives, no code fences. Under 300 words. Another round will format this.",
].join("\n");

const RELATE_SYSTEM = [
  "You are the PATTERNS round of a Synap workspace report.",
  "You receive the raw gathered data AND the analyst's read of it. Your job is what",
  "the analyst did NOT do: surface RELATIONSHIPS and things worth attention —",
  "clusters, repeated themes, people or companies that recur across kinds, gaps",
  "where a kind is conspicuously empty, and anything that looks like it needs a",
  "decision. Prefer three sharp observations over ten shallow ones.",
  EVIDENCE_RULE,
  STEER_RULE,
  "When you name a specific record, write it as [[<kind>:<id>|<label>]] using an id",
  "that appears verbatim in the gathered data. If you are unsure of an id, use the",
  "plain label instead — a wrong id is worse than no link.",
  "Output PLAIN PROSE, under 250 words. No headings, no directives, no code fences.",
].join("\n");

// The assembler is the ONLY round that emits Synap-flavoured markdown, and the only
// place the container syntax is taught. There is no prior art in the codebase for
// this syntax, so the rules and a worked example are stated in full.
const ASSEMBLE_SYSTEM = [
  "You are the ASSEMBLER round of a Synap workspace report. You compose the FINAL",
  "document body in Synap-flavoured markdown. You add no new facts — you arrange,",
  "title, and format what the earlier rounds produced.",
  "",
  "SYNAP MARKDOWN SYNTAX — these rules are absolute:",
  "1. A section is a FOUR-COLON container that must be opened and closed:",
  '   ::::synap-section{agent="analyst" round="analyze" confidence="0.8"}',
  "   ...content...",
  "   ::::",
  "2. Leaf embeds use THREE colons and MUST BE CLOSED with their own ::: line.",
  "   There is NO self-closing form. An unclosed embed swallows every line that",
  "   follows it until the section ends, and that content is LOST. Always write",
  "   the closing ::: immediately after the opening line:",
  '   :::synap-cell{instanceId="..."}',
  "   :::",
  '   :::synap-view{viewId="..."}',
  "   :::",
  '   :::synap-entity{id="..."}',
  "   :::",
  "3. The outer container must always have STRICTLY MORE colons than anything nested",
  "   inside it. Four outside, three inside. If you ever nest a four-colon block in a",
  "   four-colon block the section closes early and the rest of the report leaks out.",
  "4. Attributes are REFERENCE-ONLY: short bare values. Never inline JSON, never a",
  "   value containing a double quote or a } character.",
  "5. The ONLY section attributes that survive are: id, agent, round, skills,",
  "   confidence, stepRunId, nodeId, status. Anything else is silently dropped.",
  '6. confidence is a 0-1 ratio written as a decimal string, e.g. confidence="0.8".',
  "   Never a percentage.",
  "7. Reference a record inline as [[<kind>:<id>|<label>]] — it renders as a chip.",
  "   Only use ids that appear verbatim in the material you were given. This report",
  "   is READ-ONLY prose: inventing an id produces a dead chip.",
  "",
  "STRUCTURE: one ::::synap-section per round, in order — analyze, then relate.",
  'Open with a single "# " title line ABOVE the first section.',
  "",
  // The assembler adds no facts, so its steer duty is narrower than the earlier
  // rounds': the STEER decides the TITLE and the ORDER, never new content.
  "STEER HANDLING: if the STEER lines are empty, title the report generically",
  '("Workspace report — <period>") and keep the rounds in their given order. If any',
  "STEER line has text, name that subject in the title and lead each section with",
  "the material that answers it. Never add facts the rounds did not give you.",
  "",
  'MISSING ROUNDS: if a round\'s material looks like {"error": "..."} or is empty,',
  'you MUST still emit its section, with status="failed", containing one visible',
  "sentence naming what is missing. NEVER silently produce a shorter report — a",
  "reader must be able to see that a round did not run.",
  "",
  "WORKED EXAMPLE of correct output:",
  "# Workspace report — July 2026",
  "",
  '::::synap-section{agent="analyst" round="analyze" confidence="0.8"}',
  "Twelve open tasks, most untouched since the sprint opened. Notes are thin.",
  "::::",
  "",
  '::::synap-section{agent="analyst" round="relate" status="failed" confidence="0.2"}',
  "This section is missing: the patterns round failed and produced no material.",
  "::::",
  "",
  "Be CONCISE — your entire output must fit in 2000 tokens. Emit ONLY the markdown",
  "document. No preamble, no explanation, no code fences around the whole thing.",
].join("\n");

const SUMMARIZE_SYSTEM = [
  "Write ONE plain sentence, under 200 characters, stating what this report found.",
  "No markdown, no directives, no quotes, no leading label. Just the sentence.",
  'If the material is an error or empty, write exactly: "Report generated with ' +
    'incomplete data."',
].join("\n");

// ── Flow definition ───────────────────────────────────────────────────────────

/**
 * The node graph. Linear in effect (the executor walks it topologically and runs
 * steps sequentially in one worker invocation), but authored as a fan-out/fan-in so
 * the four independent gathers are honestly expressed as independent.
 */
export const REPORT_AUTOMATION_FLOW: FlowDefinition = {
  nodes: [
    {
      id: "trigger",
      type: "trigger",
      position: { x: 0, y: 200 },
      data: {
        triggerType: "manual",
        label: "Run report",
        config: {},
      },
    },
    {
      id: "now",
      type: "compute",
      position: { x: 200, y: 200 },
      data: {
        label: "Timestamp",
        operation: "now",
      },
    },
    // ── Round 1: GATHER (deterministic, no AI) ────────────────────────────────
    // Four independent reads of real workspace state. `continueOnError` so one
    // dead read degrades the report instead of killing the run.
    {
      id: "gather-tasks",
      type: "query",
      position: { x: 420, y: 20 },
      data: {
        label: "Tasks",
        profileSlug: "task",
        filter: "",
        limit: 25,
        errorHandling: { continueOnError: true },
      },
    },
    {
      id: "gather-notes",
      type: "query",
      position: { x: 420, y: 140 },
      data: {
        label: "Notes",
        profileSlug: "note",
        filter: "",
        limit: 15,
        errorHandling: { continueOnError: true },
      },
    },
    {
      id: "gather-people",
      type: "query",
      position: { x: 420, y: 260 },
      data: {
        label: "People",
        profileSlug: "person",
        filter: "",
        limit: 15,
        errorHandling: { continueOnError: true },
      },
    },
    {
      id: "gather-companies",
      type: "query",
      position: { x: 420, y: 380 },
      data: {
        label: "Companies",
        profileSlug: "company",
        filter: "",
        limit: 15,
        errorHandling: { continueOnError: true },
      },
    },
    // ── Round 2: ANALYZE ──────────────────────────────────────────────────────
    {
      id: "analyze",
      type: "capability",
      position: { x: 660, y: 200 },
      data: {
        label: "Analyze",
        verbId: "ai.generate",
        verbKind: "read",
        inputMapping: {
          system: ANALYZE_SYSTEM,
          prompt: [STEER_BLOCK, "", GATHERED_DATA].join("\n"),
          maxTokens: "900",
        },
        // A failed round must become a VISIBLE GAP in the report, not an aborted
        // run — the assembler is instructed to render it.
        errorHandling: { continueOnError: true },
      },
    },
    // ── Round 3: RELATE / NOTICE ──────────────────────────────────────────────
    {
      id: "relate",
      type: "capability",
      position: { x: 900, y: 200 },
      data: {
        label: "Patterns",
        verbId: "ai.generate",
        verbKind: "read",
        inputMapping: {
          system: RELATE_SYSTEM,
          prompt: [
            STEER_BLOCK,
            "",
            GATHERED_DATA,
            "",
            "ANALYST'S READ:",
            "{{steps.analyze.output}}",
          ].join("\n"),
          maxTokens: "800",
        },
        errorHandling: { continueOnError: true },
      },
    },
    // ── Round 4: ASSEMBLE (fail-fast — no body, no report) ────────────────────
    {
      id: "assemble",
      type: "capability",
      position: { x: 1140, y: 200 },
      data: {
        label: "Assemble",
        verbId: "ai.generate",
        verbKind: "read",
        inputMapping: {
          system: ASSEMBLE_SYSTEM,
          prompt: [
            STEER_BLOCK,
            "",
            "Report generated at: {{steps.now.output.result}}",
            "",
            "ANALYZE ROUND MATERIAL:",
            "{{steps.analyze.output}}",
            "",
            "RELATE ROUND MATERIAL:",
            "{{steps.relate.output}}",
          ].join("\n"),
          maxTokens: "2000",
        },
      },
    },
    // The `report` profile carries a `summary` property that the header renders.
    // The assembled body is far too long for it, so one short derived call fills it.
    {
      id: "summarize",
      type: "capability",
      position: { x: 1380, y: 200 },
      data: {
        label: "One-line summary",
        verbId: "ai.generate",
        verbKind: "read",
        inputMapping: {
          system: SUMMARIZE_SYSTEM,
          prompt: "{{steps.analyze.output}}",
          // 500, NOT the ~120 a one-line summary "needs". DOGFOODED 2026-07-26
          // against the live IS: `ai.generate` returns an EMPTY STRING at
          // maxTokens 20 and 120, a degraded answer at 300, and a correct one at
          // 500. The budget is consumed before any visible token is emitted —
          // the signature of a reasoning model — so a low ceiling does not
          // produce a SHORT answer, it produces NO answer, silently and with a
          // successful step status. Brevity belongs in the prompt, not the cap.
          maxTokens: "500",
        },
        // NO continueOnError, deliberately. `summary` is a STRING property
        // rendered verbatim in the report header, and `{{steps.summarize.output}}`
        // is an exact whole-string placeholder — so `deepResolveTemplates` passes
        // the step output through NATIVELY. With continueOnError a failed round
        // records `{error: "..."}` as its output, and that OBJECT would land in
        // `properties.summary` and render as `{"error":"…"}` to the reader.
        // A report with no summary is fine; a report whose summary is a raw
        // error object is not. Failing the run here is the honest outcome.
      },
    },
    // ── Fail closed before writing ────────────────────────────────────────────
    {
      id: "guard-assembled",
      type: "guard",
      position: { x: 1620, y: 200 },
      data: {
        label: "Body assembled",
        checks: [
          {
            path: "steps.assemble.output",
            exists: true,
            message:
              "The assembler produced no body — refusing to write an empty report.",
          },
          {
            path: "steps.assemble.output.error",
            exists: false,
            message:
              "The assembler round failed — refusing to write a report without a body.",
          },
        ],
      },
    },
    // ── Output ────────────────────────────────────────────────────────────────
    {
      id: "create-report",
      type: "output",
      position: { x: 1860, y: 200 },
      data: {
        label: "Create report",
        outputType: "entity_create",
        config: {
          profileSlug: "report",
          title: "Workspace report — {{steps.now.output.result}}",
          properties: {
            reportPeriod: "{{steps.now.output.result}}",
            generatedAt: "{{steps.now.output.result}}",
            reportStatus: "ready",
            summary: "{{steps.summarize.output}}",
            // Context chips. The renderer tolerates `["label"]` as well as
            // `[{id,kind,label}]`; plain labels are what this flow can honestly
            // assert, since the gather nodes read kinds, not named sources.
            reportSources: ["Tasks", "Notes", "People", "Companies"],
          },
          // The whole string is one placeholder → `deepResolveTemplates` hands the
          // markdown through as a native string, and the entity_create node
          // materializes it into a `documents` row linked via entities.documentId.
          body: "{{steps.assemble.output}}",
        },
      },
    },
  ],
  edges: [
    { id: "e-trigger-now", source: "trigger", target: "now" },
    { id: "e-now-tasks", source: "now", target: "gather-tasks" },
    { id: "e-now-notes", source: "now", target: "gather-notes" },
    { id: "e-now-people", source: "now", target: "gather-people" },
    { id: "e-now-companies", source: "now", target: "gather-companies" },
    { id: "e-tasks-analyze", source: "gather-tasks", target: "analyze" },
    { id: "e-notes-analyze", source: "gather-notes", target: "analyze" },
    { id: "e-people-analyze", source: "gather-people", target: "analyze" },
    {
      id: "e-companies-analyze",
      source: "gather-companies",
      target: "analyze",
    },
    { id: "e-analyze-relate", source: "analyze", target: "relate" },
    { id: "e-relate-assemble", source: "relate", target: "assemble" },
    { id: "e-assemble-summarize", source: "assemble", target: "summarize" },
    { id: "e-summarize-guard", source: "summarize", target: "guard-assembled" },
    {
      id: "e-guard-create",
      source: "guard-assembled",
      target: "create-report",
    },
  ],
};

export interface EnsureReportAutomationResult {
  status: "created" | "updated" | "skipped" | "error";
  message: string;
  automationId?: string;
  error?: string;
}

/**
 * Create the report automation for a workspace if it does not already exist.
 *
 * Idempotent and keyed on (workspaceId, name) — matching `ensureDefaultCommands`'s
 * title-keyed reconcile. A user who edited or deleted their copy is NOT overwritten
 * or resurrected on the next call... except deletion, which does re-seed; that is the
 * same behavior every other `ensure*` door has, and the same tradeoff.
 */
export async function ensureReportAutomation(
  workspaceId: string,
  userId: string
): Promise<EnsureReportAutomationResult> {
  try {
    // INSIDE the try, deliberately. This runs from `workspaces.get` — a hot read
    // path awaited without its own try/catch — so a connection-pool throw here
    // would propagate out and 500 the entire workspace read for every caller.
    // Seeding an automation must never be able to take down reading a workspace.
    const db = await getDb();

    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
    });
    if (!workspace) {
      return {
        status: "error",
        message: `Workspace ${workspaceId} not found`,
        error: "WORKSPACE_NOT_FOUND",
      };
    }

    const existing = await db.query.automations.findFirst({
      where: and(
        eq(automations.workspaceId, workspaceId),
        eq(automations.name, REPORT_AUTOMATION_NAME)
      ),
      columns: { id: true, metadata: true },
    });

    if (existing) {
      const seededVersion = (
        existing.metadata as { seedVersion?: number } | null
      )?.seedVersion;

      // UPGRADE PATH. A pure skip-if-exists reconcile makes the FIRST prompt bug
      // permanent: ~half this file is prompt copy, the row is duplicated per
      // workspace, and there is no single row to fix. That is unacceptable for a
      // flow whose whole point is being iterated on after reading its output.
      // So: bump REPORT_AUTOMATION_SEED_VERSION whenever the definition changes
      // and every workspace picks it up on its next reconcile.
      //
      // TRADEOFF, stated: this OVERWRITES a user's edits to the seeded flow on a
      // version bump. That is why the version is bumped deliberately and never
      // as a side effect of an unrelated edit. A user who wants a permanent
      // variant should duplicate the automation under another name — a different
      // name is a different reconcile key and is never touched here.
      if (seededVersion === REPORT_AUTOMATION_SEED_VERSION) {
        return {
          status: "skipped",
          message: "Report automation already current",
          automationId: existing.id,
        };
      }

      await db
        .update(automations)
        .set({
          description: REPORT_AUTOMATION_DESCRIPTION,
          flowDefinition: REPORT_AUTOMATION_FLOW,
          metadata: { seedVersion: REPORT_AUTOMATION_SEED_VERSION },
          updatedAt: new Date(),
        })
        .where(eq(automations.id, existing.id));

      return {
        status: "updated",
        message: `Upgraded report automation to seed v${REPORT_AUTOMATION_SEED_VERSION}`,
        automationId: existing.id,
      };
    }

    const [row] = await db
      .insert(automations)
      .values({
        workspaceId,
        createdBy: userId,
        name: REPORT_AUTOMATION_NAME,
        description: REPORT_AUTOMATION_DESCRIPTION,
        triggerType: "manual",
        triggerConfig: {},
        flowDefinition: REPORT_AUTOMATION_FLOW,
        metadata: { seedVersion: REPORT_AUTOMATION_SEED_VERSION },
        // `active` so the trigger door will actually run it. There is no schedule,
        // so an active manual automation costs nothing until a human runs it.
        status: "active",
      })
      .returning({ id: automations.id });

    return {
      status: "created",
      message: "Created report automation",
      automationId: row?.id,
    };
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(
      `[ensureReportAutomation] Error seeding report automation for workspace ${workspaceId}:`,
      { error: err.message, stack: err.stack }
    );
    return {
      status: "error",
      message: `Failed to seed report automation: ${err.message}`,
      error: err.message,
    };
  }
}

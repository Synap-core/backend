/**
 * A ONE-SHOT playbook run (`executor: "generate"`, plan 08e4fba7 slice 1,
 * founder decisions of 9 Nov 2026).
 *
 * A button that drafts four lines (a post's caption) used to start a full agent
 * run: a session, a room, a recall, a 19-tool agent turn with a 24k-token
 * prompt, a checkpoint and a continuation (document 2e7a93d1: 252k input
 * tokens for one caption). A one-shot playbook instead runs as:
 *
 *   1. resolve (the run door already did), the subject check, one open run per
 *      subject (`idempotentBySubject`), the params rendered into the goal;
 *   2. ONE `playbook_runs` row (`session_id` NULL) — the run's record: status,
 *      model, tokens, prompt text (`generation`, 0417);
 *   3. the prompt, made by the POD from what the playbook declares: its method
 *      (context skill + guidance, the rules it follows), its rendered goal, the
 *      subject's fields and the subject's own document;
 *   4. ONE call through the `ai.generate` verb (no tools, no turn loop);
 *   5. the result filed as a PROPOSAL on the subject, where the playbook's one
 *      output says it lands (`ExpectedOutput.lands`): today a section of the
 *      subject's document, through THE document patch door, AI-owned and
 *      always reviewed (`forReview`). The person approves it inline in the app
 *      that asked, or in Needs you, as any proposal.
 *
 * NOT created: a session, a room, a recall, a kickoff message, a tool profile,
 * an IS agent turn, a continuation, an enrolment. No reaper looks at it: a
 * filed run is `proposed` (settled), and its `running` window is the one
 * synchronous call.
 *
 * The door's answer (`GeneratedRunAnswer`) is synchronous: the run id, the
 * proposal id and its review link, so the app shows the draft inline at once.
 */

import { TRPCError } from "@trpc/server";
import {
  and,
  desc,
  drizzleSql,
  eq,
  entities,
  getDb,
  playbookRuns,
  proposals,
} from "@synap/database";
import type {
  Playbook,
  PlaybookRun,
  PlaybookRunGeneration,
  PlaybookRunGenerationExamples,
} from "@synap/database/schema";
import { ProposalStatus } from "@synap/database/schema";
import type { ExpectedOutput, OutputLandingExamples } from "@synap/playbooks";
import {
  fillParamsFromSubject,
  needsSubjectKinds,
  readPlaybookParams,
  validatePlaybookParams,
} from "@synap/playbooks";
import type { RunOn } from "@synap-core/types/agents";
import {
  AiUsageCollector,
  withAiUsageCapture,
} from "@synap/intelligence-client";
import { createLogger } from "@synap-core/core";
import {
  PlaybookParamsError,
  renderSubjectParamValues,
  resolveGoal,
  withDeclaredParamsDefaulted,
} from "./playbook-lifecycle.js";
import { loadRunMethodParts, renderPlaybookMethod } from "./playbook-method.js";
import { subjectKindSlugs } from "./assert-subject-kind.js";
import { loadEditableDocument } from "../../utils/document-edit-access.js";
import {
  applyDocumentPatch,
  loadPatchDocument,
  readPatchDocumentContent,
} from "../document-patch/apply-document-patch.js";
import {
  examplesAsked,
  readPastOutcomes,
  type PastOutcome,
  type PastOutcomeWithoutText,
} from "./generate-examples.js";

const logger = createLogger({ module: "generate-run" });

/** The machine author of every proposal a one-shot run files. */
export const GENERATE_RUN_AUTHOR = "system:generate-run" as const;

/**
 * The prompt's size bound. The IS `/v1/tools/generate` refuses a prompt over
 * 24,000 characters (`GenerateBodySchema`) and fences it as untrusted content;
 * the margin keeps the fenced prompt under that bound.
 */
export const GENERATE_PROMPT_MAX_CHARS = 22_000;

/** One property value in the prompt is cut at this many characters. */
const PROPERTY_VALUE_MAX_CHARS = 1_000;

/** One past outcome's text in the prompt is cut at this many characters. */
export const EXAMPLE_TEXT_MAX_CHARS = 1_500;

/** A rejection reason in the prompt is cut at this many characters. */
const EXAMPLE_REASON_MAX_CHARS = 300;

/** The truncation point of the one call (a draft, never a long document). */
const GENERATE_MAX_TOKENS = 2_000;

/** The system line of every one-shot call. */
export const GENERATE_SYSTEM =
  "You draft one piece of text for a person, who reviews it before it is used. " +
  "Follow the instructions and the rules you are given. Answer with the text itself only: " +
  "no preamble, no heading, no code fence, and no note about what you did.";

/** What the run door answers for a one-shot run. */
export interface GeneratedRunAnswer {
  runId: string;
  status: "proposed";
  /** The proposal the result was filed as: approve, edit or reject it inline. */
  proposalId: string;
  reviewUrl: string;
  reviewPath: string;
  subjectId: string;
  /** Where it lands once approved. */
  documentId: string;
  sectionId: string;
  section: string;
  /** An earlier run's still-pending proposal was returned (`idempotentBySubject`). */
  reused?: true;
}

export interface GenerateRunInput {
  playbook: Playbook;
  workspaceId: string | null;
  /** The person the run is for (the owner of the run and of the proposal). */
  userId: string;
  subjectId: string | null;
  params: Record<string, unknown>;
  runOn: RunOn | null;
  idempotentBySubject?: boolean;
  /** A caller-resolved goal (the automation path's StepContext resolver). */
  goalOverride?: string;
}

/** The section id a landing's title is written under (its slug). */
export function sectionIdFor(section: string): string {
  const slug = section
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug || "draft";
}

/**
 * The ONE output a generate playbook lands, or why it cannot run. A one-shot
 * playbook declares exactly one output with `lands`; anything else is refused
 * before any row exists.
 */
export function readGenerateLanding(
  playbook: Pick<Playbook, "expectedOutputs" | "name">
): {
  output: ExpectedOutput;
  /** Where it lands, as the run records it (`generation.lands`). */
  lands: NonNullable<PlaybookRunGeneration["lands"]>;
  /** The past outcomes it asks for as examples (`lands.examples`), if any. */
  examples?: OutputLandingExamples;
} {
  const outputs = Array.isArray(playbook.expectedOutputs)
    ? (playbook.expectedOutputs as ExpectedOutput[])
    : [];
  const landing = outputs.filter(
    (o) =>
      o &&
      typeof o === "object" &&
      o.lands &&
      o.lands.target === "subject_document_section" &&
      typeof o.lands.section === "string" &&
      o.lands.section.trim() !== ""
  );
  if (landing.length !== 1) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        landing.length === 0
          ? `"${playbook.name}" runs as one draft (executor generate) but none of its outputs says where the draft lands: declare one output with lands: { target: "subject_document_section", section: "<title>" }.`
          : `"${playbook.name}" runs as one draft (executor generate) but ${landing.length} of its outputs say where they land: a one-shot playbook lands exactly one.`,
    });
  }
  const output = landing[0]!;
  const examples = output.lands!.examples;
  return {
    output,
    lands: {
      target: "subject_document_section",
      section: output.lands!.section.trim(),
      ...(output.lands!.owner === "person" ? { owner: "person" as const } : {}),
    },
    ...(examples && typeof examples === "object" ? { examples } : {}),
  };
}

/** One property value as one prompt line's text. */
function propertyText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : Array.isArray(value) &&
            value.every((v) => typeof v === "string" || typeof v === "number")
          ? value.join(", ")
          : JSON.stringify(value);
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.length > PROPERTY_VALUE_MAX_CHARS
    ? `${trimmed.slice(0, PROPERTY_VALUE_MAX_CHARS)}…`
    : trimmed;
}

/** What the model answered, as a section body. */
export function draftBodyOf(output: unknown, section: string): string {
  let text = typeof output === "string" ? output : JSON.stringify(output);
  text = text.trim();
  // A fenced answer ("```markdown … ```") is unwrapped.
  const fence = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/.exec(text);
  if (fence) text = fence[1]!.trim();
  // A leading heading that repeats the section title is the section's own.
  const lines = text.split("\n");
  const first = lines[0]
    ?.replace(/^#+\s*/, "")
    .trim()
    .toLowerCase();
  if (/^#+\s/.test(lines[0] ?? "") && first === section.trim().toLowerCase()) {
    text = lines.slice(1).join("\n").trim();
  }
  return text;
}

interface PromptParts {
  text: string;
  context: PlaybookRunGeneration["context"];
  /** The past outcomes given: those shown, and those left out for room. */
  examples: {
    used: Extract<PlaybookRunGenerationExamples, { used: unknown }>["used"];
    overBound: PastOutcome[];
  };
}

/** One past outcome as a prompt part: a heading line and its text. */
function exampleText(o: PastOutcome): {
  text: string;
  truncated: boolean;
  reason: boolean;
} {
  const where = o.subjectTitle ? ` for "${o.subjectTitle}"` : "";
  const reason = o.reason
    ? o.reason.replace(/\s+/g, " ").slice(0, EXAMPLE_REASON_MAX_CHARS)
    : null;
  const head =
    o.outcome === "approved"
      ? `### Approved${where}, as the person kept it`
      : `### Rejected${where}${reason ? `. Their reason: ${reason}` : ""}`;
  const truncated = o.text.length > EXAMPLE_TEXT_MAX_CHARS;
  const body = truncated
    ? `${o.text.slice(0, EXAMPLE_TEXT_MAX_CHARS)}…`
    : o.text;
  return { text: `${head}\n${body}`, truncated, reason: reason !== null };
}

/**
 * The examples block, fitted into `room` characters: each past outcome in
 * order (approved first, then rejected, most recent first) while it fits;
 * one that does not is left out (`overBound`) and the next is tried. Null
 * when none fits.
 */
function examplesBlock(
  section: string,
  outcomes: PastOutcome[],
  room: number
): {
  text: string | null;
  used: PromptParts["examples"]["used"];
  overBound: PastOutcome[];
} {
  const head = [
    `## Earlier "${section}" drafts the person decided`,
    "Drafts this playbook wrote before, which the person approved or rejected. " +
      "Write like the approved ones, as they kept them, and avoid what made them reject the others. " +
      "They are examples for the voice and the shape: never copy one, and take no fact from them.",
  ].join("\n");
  const parts: string[] = [];
  const used: PromptParts["examples"]["used"] = [];
  const overBound: PastOutcome[] = [];
  let size = head.length;
  for (const o of outcomes) {
    const part = exampleText(o);
    const cost = part.text.length + 2;
    if (size + cost > room) {
      overBound.push(o);
      continue;
    }
    size += cost;
    parts.push(part.text);
    used.push({
      outcome: o.outcome,
      proposalId: o.proposalId,
      runId: o.runId,
      chars: part.text.length,
      ...(part.reason ? { reason: true as const } : {}),
      ...(part.truncated ? { truncated: true as const } : {}),
    });
  }
  if (parts.length === 0) return { text: null, used, overBound };
  return { text: [head, ...parts].join("\n\n"), used, overBound };
}

/**
 * The prompt the pod makes: the method (context skill + rules), the rendered
 * goal, the subject's fields, the subject's document, and how to answer. Cut
 * to {@link GENERATE_PROMPT_MAX_CHARS}: the document first, then the fields;
 * the method and the goal are never cut (a playbook whose method alone
 * exceeds the bound is refused). Past outcomes (`examples`) take only the room
 * the subject leaves: they are left out first, the subject is never cut for
 * them.
 */
export function buildGeneratePrompt(input: {
  method: { contextSkill: string | null; guidance: string };
  goal: string;
  section: string;
  subject: {
    id: string;
    title: string | null;
    kind: string;
    properties: Record<string, unknown>;
  };
  document: { id: string; title: string; content: string } | null;
  /** Past outcomes to show as examples, in order (`readPastOutcomes`). */
  examples?: PastOutcome[];
}): PromptParts {
  const methodText = renderPlaybookMethod({
    contextSkill: input.method.contextSkill,
    guidance: input.method.guidance,
  });
  const answer = [
    "## Your answer",
    `Answer with the "${input.section}" text only. It is filed as a draft for the person to review: nothing is written until they approve it.`,
  ].join("\n");
  const fixed = [methodText, input.goal.trim(), answer].filter(Boolean);
  const fixedChars = fixed.join("\n\n").length;

  const subjectHead = `## The ${input.subject.kind}: ${input.subject.title ?? "(untitled)"}`;
  const propertyLines = Object.entries(input.subject.properties ?? {})
    .map(([key, value]) => {
      const text = propertyText(value);
      return text === null ? null : `- ${key}: ${text}`;
    })
    .filter((l): l is string => l !== null);
  const docHead = input.document
    ? `## Its document: ${input.document.title}`
    : null;

  // Room left for the two context reads (the joins between parts included).
  let room =
    GENERATE_PROMPT_MAX_CHARS -
    fixedChars -
    subjectHead.length -
    (docHead ? docHead.length : 0) -
    16;
  if (room < 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `This playbook's method and goal take ${fixedChars} characters, over the one-shot bound of ${GENERATE_PROMPT_MAX_CHARS}: shorten its rules or goal.`,
    });
  }

  // Fields first (they are short and name the brief), then the document.
  let fields = propertyLines.join("\n");
  let fieldsTruncated = false;
  if (fields.length > room) {
    fields = fields.slice(0, Math.max(0, room - 1)) + "…";
    fieldsTruncated = true;
  }
  room -= fields.length;
  let docText = input.document?.content.trim() ?? "";
  let docTruncated = false;
  if (input.document && docText.length > room) {
    docText =
      room > 1
        ? `${docText.slice(0, room - 40)}\n\n[… the rest of the document is cut]`
        : "";
    docTruncated = true;
  }

  const subjectBlock = [subjectHead, fields].filter(Boolean).join("\n");
  const docBlock = docHead ? [docHead, docText].filter(Boolean).join("\n") : "";
  const withoutExamples = [
    methodText,
    input.goal.trim(),
    subjectBlock,
    docBlock,
    answer,
  ].filter(Boolean);
  // The examples take what the subject left, joins included.
  const fitted = examplesBlock(
    input.section,
    input.examples ?? [],
    GENERATE_PROMPT_MAX_CHARS - withoutExamples.join("\n\n").length - 2
  );
  const text = (
    fitted.text
      ? [...withoutExamples.slice(0, -1), fitted.text, answer]
      : withoutExamples
  ).join("\n\n");

  const context: PlaybookRunGeneration["context"] = [];
  if (methodText) context.push({ kind: "method", chars: methodText.length });
  context.push({
    kind: "subject",
    id: input.subject.id,
    chars: subjectBlock.length,
    ...(fieldsTruncated ? { truncated: true } : {}),
  });
  if (input.document) {
    context.push({
      kind: "subject_document",
      id: input.document.id,
      chars: docBlock.length,
      ...(docTruncated ? { truncated: true } : {}),
    });
  }
  if (fitted.text) {
    context.push({
      kind: "examples",
      chars: fitted.text.length,
      ...(fitted.overBound.length > 0 ? { truncated: true } : {}),
    });
  }
  return {
    text,
    context,
    examples: { used: fitted.used, overBound: fitted.overBound },
  };
}

/** The pending proposal an earlier run of this playbook filed on this subject. */
async function openGenerateRunFor(
  playbookId: string,
  subjectId: string
): Promise<PlaybookRun | null> {
  const db = await getDb();
  const [latest] = await db
    .select()
    .from(playbookRuns)
    .where(
      and(
        eq(playbookRuns.playbookId, playbookId),
        drizzleSql`${playbookRuns.generation}->>'subjectId' = ${subjectId}`
      )
    )
    .orderBy(desc(playbookRuns.startedAt))
    .limit(1);
  if (!latest) return null;
  if (latest.status === "running") return latest as PlaybookRun;
  const proposalId = latest.generation?.proposal?.id;
  if (latest.status !== "proposed" || !proposalId) return null;
  const [p] = await db
    .select({ status: proposals.status })
    .from(proposals)
    .where(eq(proposals.id, proposalId))
    .limit(1);
  return p?.status === ProposalStatus.PENDING ? (latest as PlaybookRun) : null;
}

function answerOf(run: PlaybookRun, reused?: true): GeneratedRunAnswer | null {
  const g = run.generation;
  if (!g?.proposal || !g.subjectId || !g.lands) return null;
  return {
    runId: run.id,
    status: "proposed",
    proposalId: g.proposal.id,
    reviewUrl: g.proposal.reviewUrl,
    reviewPath: g.proposal.reviewPath,
    subjectId: g.subjectId,
    documentId: g.proposal.documentId,
    sectionId: g.proposal.sectionId,
    section: g.lands.section,
    ...(reused ? { reused } : {}),
  };
}

/**
 * Write the run's record, then its verdict through THE one writer after an
 * executor (`recordExecutorResult`: status, `completed_at`, and a child of an
 * automation run settles its parent).
 */
async function settleRun(
  runId: string,
  patch: {
    status: "proposed" | "failed";
    summary?: string;
    error?: string;
    generation: PlaybookRunGeneration;
  }
): Promise<PlaybookRun> {
  const db = await getDb();
  await db
    .update(playbookRuns)
    .set({ generation: patch.generation })
    .where(eq(playbookRuns.id, runId));
  const { recordExecutorResult } = await import("./run-playbook.js");
  return recordExecutorResult(runId, {
    status: patch.status,
    ...(patch.summary ? { summary: patch.summary } : {}),
    ...(patch.error ? { error: patch.error } : {}),
  });
}

/**
 * Run a one-shot playbook. Returns the run row and the door's answer; THROWS
 * on a refusal before any row exists (no subject, no landing, a missing param,
 * a document the person cannot edit) and on a failure after it (the run row is
 * then `failed` with the error and whatever the call reported).
 */
export async function executeGenerateRun(
  input: GenerateRunInput
): Promise<{ run: PlaybookRun; generated: GeneratedRunAnswer; reused?: true }> {
  const { playbook } = input;
  const db = await getDb();

  // ── Refusals: before any row, any read of content, any model call. ─────────
  const subjectId = input.subjectId?.trim() || null;
  if (!subjectId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `"${playbook.name}" drafts for one record: start it on its subject (subjectId).`,
    });
  }
  const { lands, examples: examplesDeclared } = readGenerateLanding(playbook);
  const asked = examplesAsked(examplesDeclared);

  // The subject: what the prompt reads, and what answers the params it
  // declares it answers (`fillParamsFromSubject`, the run funnel's own fill).
  const [subject] = await db
    .select({
      id: entities.id,
      title: entities.title,
      preview: entities.preview,
      type: entities.type,
      properties: entities.properties,
      documentId: entities.documentId,
    })
    .from(entities)
    .where(eq(entities.id, subjectId))
    .limit(1);
  if (!subject) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Subject not found." });
  }
  const declaredParams = readPlaybookParams(playbook.params);
  const subjectKinds = needsSubjectKinds(declaredParams)
    ? ((await subjectKindSlugs({
        subjectId,
        userId: input.userId,
        workspaceId: input.workspaceId,
      })) ?? [])
    : [];
  const resolution = validatePlaybookParams(
    declaredParams,
    fillParamsFromSubject(declaredParams, input.params, {
      id: subjectId,
      title: subject.title ?? null,
      preview: subject.preview ?? null,
      properties:
        (subject.properties as Record<string, unknown> | null) ?? null,
      kinds: subjectKinds,
    }).values
  );
  // Nobody to owe a param to: there is no session. A missing one refuses.
  if (
    resolution.typeErrors.length > 0 ||
    resolution.missingRequired.length > 0
  ) {
    throw new PlaybookParamsError(
      playbook.id,
      resolution.missingRequired,
      resolution.typeErrors
    );
  }

  // ── One open run per subject (the scheduled path). ─────────────────────────
  if (input.idempotentBySubject) {
    const open = await openGenerateRunFor(playbook.id, subjectId);
    const answer = open ? answerOf(open, true) : null;
    if (open && answer) return { run: open, generated: answer, reused: true };
    if (open && open.status === "running") {
      throw new TRPCError({
        code: "CONFLICT",
        message: `"${playbook.name}" is already drafting for this record (run ${open.id}).`,
      });
    }
  }

  // ── What the prompt reads: the subject's document, as the person. ─────────
  if (!subject.documentId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `"${subject.title ?? "This record"}" has no document, so "${playbook.name}" has nowhere to put its "${lands.section}" draft.`,
    });
  }
  // The person must be able to edit where the draft lands (and read it):
  // checked BEFORE the model call, so a refused landing costs nothing.
  await loadEditableDocument(input.userId, subject.documentId);
  const doc = await loadPatchDocument(subject.documentId);
  const content = await readPatchDocumentContent(doc);

  const goal =
    input.goalOverride ??
    resolveGoal(
      playbook.goalTemplate,
      withDeclaredParamsDefaulted(
        declaredParams,
        renderSubjectParamValues(declaredParams, resolution.values, {
          id: subjectId,
          title: subject.title ?? null,
        })
      ),
      playbook.id
    );

  // ── The run row: the record, before anything is spent. ─────────────────────
  const { buildDefinitionSnapshot } = await import("./run-playbook.js");
  const base: PlaybookRunGeneration = {
    subjectId,
    lands,
    context: [],
    prompt: { system: GENERATE_SYSTEM, text: "", chars: 0 },
    model: null,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    totalTokens: null,
    costUsd: null,
    finishReason: null,
    outputChars: null,
  };
  const [run] = await db
    .insert(playbookRuns)
    .values({
      workspaceId: input.workspaceId,
      playbookId: playbook.id,
      sessionId: null,
      executor: "generate",
      ...(input.runOn ? { runOn: input.runOn } : {}),
      status: "running",
      input: resolution.values,
      createdBy: input.userId,
      definitionSnapshot: buildDefinitionSnapshot(playbook),
      generation: base,
    })
    .returning();
  const runId = run!.id;

  let record: PlaybookRunGeneration = base;
  const collector = new AiUsageCollector();
  try {
    // The method: the context skill and the rules this playbook follows; the
    // rules it used are stamped on the run's snapshot (as every run's are).
    const method = await loadRunMethodParts({
      playbookId: playbook.id,
      userId: input.userId,
      runId,
      sessionId: null,
      warn: (obj, msg) => logger.warn(obj, `generate: ${msg}`),
    });
    // Past outcomes, when the landing asks for them. A FAILED read is not
    // "none": the run goes on without examples and its record says why.
    let past: {
      outcomes: PastOutcome[];
      withoutText: PastOutcomeWithoutText[];
    } | null = null;
    let examplesError: string | null = null;
    if (asked.approved > 0 || asked.rejected > 0) {
      try {
        past = await readPastOutcomes({
          playbookId: playbook.id,
          workspaceId: input.workspaceId,
          userId: input.userId,
          asked,
        });
      } catch (err) {
        examplesError = err instanceof Error ? err.message : String(err);
        logger.warn(
          { err, runId, playbookId: playbook.id },
          "generate: reading past outcomes failed; drafting without examples"
        );
      }
    }
    const prompt = buildGeneratePrompt({
      method: { contextSkill: method.contextSkill, guidance: method.guidance },
      goal,
      section: lands.section,
      subject: {
        id: subjectId,
        title: subject.title ?? null,
        kind: subject.type,
        properties: (subject.properties ?? {}) as Record<string, unknown>,
      },
      document: { id: doc.id, title: doc.title, content },
      ...(past ? { examples: past.outcomes } : {}),
    });
    const examplesRecord =
      examplesError !== null
        ? { asked, error: examplesError.slice(0, 500) }
        : past
          ? examplesRecordOf(asked, past.withoutText, prompt.examples)
          : null;
    record = {
      ...record,
      ...(examplesRecord ? { examples: examplesRecord } : {}),
      context: prompt.context,
      prompt: {
        system: GENERATE_SYSTEM,
        text: prompt.text,
        chars: GENERATE_SYSTEM.length + prompt.text.length,
      },
    };

    // ONE call, through the `ai.generate` verb (the one model door; no tools).
    const { BUILTIN_VERBS } = await import("../capabilities/builtin-verbs.js");
    const output = await withAiUsageCapture(collector, () =>
      BUILTIN_VERBS["ai.generate"]!(
        {
          system: GENERATE_SYSTEM,
          prompt: prompt.text,
          maxTokens: GENERATE_MAX_TOKENS,
        },
        { userId: input.userId, workspaceId: input.workspaceId }
      )
    );
    record = withUsage(record, collector);
    const body = draftBodyOf(output, lands.section);
    record = { ...record, outputChars: body.length };
    if (!body) throw new Error("The model answered with no draft text.");

    // The draft, filed as a PROPOSAL on the subject's document, always
    // reviewed (`forReview`), through THE patch door: an AI-owned section, or
    // (`lands.owner: "person"`) the person's own plain `## <section>` block,
    // whose body approval replaces: the one write.
    const sectionId = sectionIdFor(lands.section);
    const personOwned = lands.owner === "person";
    const filed = await applyDocumentPatch({
      userId: input.userId,
      systemAuthor: GENERATE_RUN_AUTHOR,
      forReview: { machineAuthor: GENERATE_RUN_AUTHOR },
      run: { id: runId, playbookId: playbook.id },
      documentId: doc.id,
      baseRevision: doc.contentRevision,
      ops: [
        {
          op: "upsert_section",
          id: sectionId,
          title: lands.section,
          body,
          ...(personOwned ? { form: "heading" as const } : {}),
        },
      ],
      reasoning: `"${playbook.name}" drafted the "${lands.section}" of ${subject.title ?? "this record"}.`,
    });
    if (filed.status !== "proposed") {
      // forReview always proposes; an applied write here means a door
      // changed under us. Say so rather than report a draft that is not one.
      throw new Error(
        "The draft was written without a review, which a one-shot run never does."
      );
    }
    record = {
      ...record,
      proposal: {
        id: filed.proposalId,
        reviewUrl: filed.reviewUrl,
        reviewPath: filed.reviewPath,
        documentId: doc.id,
        sectionId,
      },
    };
    const settled = await settleRun(runId, {
      status: "proposed",
      summary: `Drafted "${lands.section}" for review.`,
      generation: record,
    });
    return { run: settled, generated: answerOf(settled)! };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (collector.size > 0) record = withUsage(record, collector);
    try {
      await settleRun(runId, {
        status: "failed",
        error: message,
        generation: record,
      });
    } catch (settleErr) {
      logger.error(
        { err: settleErr, runId },
        "recording the failed one-shot run failed"
      );
    }
    throw err;
  }
}

/** What the run's record says about the past outcomes it showed. */
function examplesRecordOf(
  asked: { approved: number; rejected: number },
  withoutText: PastOutcomeWithoutText[],
  shown: PromptParts["examples"]
): PlaybookRunGenerationExamples {
  const leftOut = [
    ...withoutText.map((o) => ({ ...o, why: "no_text" as const })),
    ...shown.overBound.map((o) => ({
      outcome: o.outcome,
      proposalId: o.proposalId,
      runId: o.runId,
      why: "over_bound" as const,
    })),
  ];
  return {
    asked,
    used: shown.used,
    ...(leftOut.length > 0 ? { leftOut } : {}),
  };
}

/** The usage the one call reported, onto the record (NULL when unreported). */
function withUsage(
  record: PlaybookRunGeneration,
  collector: AiUsageCollector
): PlaybookRunGeneration {
  const totals = collector.totals();
  const detail = collector.detail();
  return {
    ...record,
    model: detail.model,
    inputTokens: totals.tokensIn,
    cachedInputTokens: detail.cachedPromptTokens,
    outputTokens: totals.tokensOut,
    totalTokens: totals.tokensTotal,
    costUsd: detail.costUsd,
    finishReason: totals.finishReason,
  };
}

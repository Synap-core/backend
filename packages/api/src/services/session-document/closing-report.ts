/**
 * The CLOSING REPORT — four machine-owned sections the session document gains
 * when a session closes: Outcome, Definition of done, What was produced,
 * Decisions.
 *
 * STRUCTURED, NEVER PROSE. Every line is projected from a stored fact — the
 * close status, the closing summary, the criteria and their current
 * evaluations, the ONE outputs door (`listSessionOutputs`), the proposals
 * decided in the session — so the report cannot say anything the pod does not
 * already know. No model is in the loop.
 *
 * MARKDOWN CONTRACT (the read path is `@synap-core/markdown-core`, allowlisted
 * directives — `DIRECTIVE_ATTRIBUTES` in its `directive-registry.ts`):
 *   - sections are top-level `synap-section` containers written by the ONE
 *     section door (`upsertSessionDocumentSection`), which sizes the fence so
 *     a `:::synap-entity` leaf can never close it early;
 *   - outputs that are entities are `synap-entity{id}` embeds written by THE
 *     embed writer (`serializeEmbed`) — REFERENCE ONLY, the card reads the
 *     live entity;
 *   - the only extra attribute is `status` on "Definition of done", carrying
 *     the verdict state (`passing` / `failing` / `incomplete`). NEVER
 *     `failed`: the renderer reads `status="failed"` as "this round did not
 *     run" and collapses the section — a failing contract must stay visible;
 *   - the per-criterion rows are a GFM table (sections cannot nest).
 *
 * IDEMPOTENT by section id: a re-close (or reopen → close) rewrites the same
 * four ids in place, and a section whose content did not change is not
 * rewritten at all (no version churn). A section a PERSON has since taken over
 * (`owner="human"`) is left alone — the door would refuse it anyway.
 */

import {
  db,
  and,
  desc,
  eq,
  inArray,
  drizzleSql,
  focusSessions,
  proposals,
  ProposalStatus,
} from "@synap/database";
import {
  buildObjectActionTitle,
  humanizeToken,
  resolveObjectNoun,
  resolveStatusLabel,
} from "@synap-core/types/vocabulary";
import {
  isTerminalSessionStatus,
  type SessionVerdict,
} from "@synap-core/types/focus-sessions";
import { isCriterionRequired, type SessionCriterion } from "@synap/playbooks";
import { serializeEmbed } from "@synap-core/markdown-core/embeds";
import { projectSessionKind } from "../focus-sessions/session-kind.js";
import { loadSessionEvaluationSummary } from "../focus-sessions/evaluations/record.js";
import { listSessionOutputs } from "../focus-sessions/session-outputs.js";
import { extractProposalName } from "../proposals/fingerprint.js";
import { parseSections, sectionOwner, serializeSection } from "./sections.js";
import { findSessionDocumentId } from "./session-document.js";
import {
  readSessionDocument,
  upsertSessionDocumentSection,
} from "./upsert-section.js";

/** `author` stamped on every closing-report section. */
export const CLOSING_REPORT_AUTHOR = "system:closing-report";

/** Stable section ids — the idempotency key. Prefixed so a person's own `outcome` never collides. */
export const CLOSING_REPORT_SECTION_IDS = {
  outcome: "close-outcome",
  definitionOfDone: "close-definition-of-done",
  produced: "close-produced",
  decisions: "close-decisions",
} as const;

/** Decided proposals listed by title; the rest are counted. */
export const CLOSING_REPORT_TOP_DECISIONS = 5;

const DECIDED_STATUSES = [
  ProposalStatus.APPROVED,
  ProposalStatus.REJECTED,
  ProposalStatus.REVERTED,
];

export interface ClosingReportInput {
  status: string;
  /** `verificationReport.summary` — the closing summary. */
  summary: string | null;
  criteria: SessionCriterion[];
  /** The CURRENT evaluation per criterion (human wins). */
  evaluations: Array<{
    criterionKey: string;
    verdict: string;
    evaluatorKind: string;
    evaluatorId: string | null;
    rationale: string | null;
  }>;
  verdict: SessionVerdict;
  /** What the session produced — the session document itself excluded. */
  outputs: Array<{ kind: string; refId: string; title: string }>;
  decisions: {
    total: number;
    items: Array<{ title: string; status: string }>;
  };
}

export interface ClosingReportSection {
  id: string;
  title: string;
  body: string;
  status?: string;
}

/** One table cell: a single line, pipes escaped. */
function cell(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|") || "—";
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The verdict as one line — the Outcome's headline claim. */
export function verdictLine(verdict: SessionVerdict): string {
  if (verdict.state === "none") return "no criteria declared";
  if (verdict.state === "passing") {
    return `all required criteria met (${verdict.passed} of ${verdict.total} passed)`;
  }
  return `${plural(verdict.requiredUnmet, "required criterion", "required criteria")} unmet (${verdict.passed} of ${verdict.total} passed)`;
}

function evaluatorLabel(e: ClosingReportInput["evaluations"][number]): string {
  const kind = humanizeToken(e.evaluatorKind);
  // A judge's model and a capability's verb say WHICH check ran; a person's
  // or an agent's id is a uuid and says nothing to a reader.
  return (e.evaluatorKind === "judge" || e.evaluatorKind === "capability") &&
    e.evaluatorId
    ? `${kind} (${e.evaluatorId})`
    : kind;
}

/** Pure: the four sections, deterministic for a given input. */
export function buildClosingReportSections(
  input: ClosingReportInput
): ClosingReportSection[] {
  const { verdict } = input;

  const outcomeBody = [
    `**${resolveStatusLabel(input.status)}** · ${verdictLine(verdict)}`,
    ...(input.summary?.trim() ? ["", input.summary.trim()] : []),
  ].join("\n");

  const byKey = new Map(input.evaluations.map((e) => [e.criterionKey, e]));
  const doneBody =
    input.criteria.length === 0
      ? "This session declared no criteria."
      : [
          "| Criterion | Result | Checked by | Why |",
          "| --- | --- | --- | --- |",
          ...input.criteria.map((c) => {
            const e = byKey.get(c.key);
            const statement = isCriterionRequired(c)
              ? c.statement
              : `${c.statement} (optional)`;
            return `| ${cell(statement)} | ${cell(resolveStatusLabel(e?.verdict ?? "unmeasured"))} | ${cell(e ? evaluatorLabel(e) : "")} | ${cell(e?.rationale ?? "")} |`;
          }),
        ].join("\n");

  const entities = input.outputs.filter((o) => o.kind === "entity");
  const others = input.outputs.filter((o) => o.kind !== "entity");
  const producedBody =
    input.outputs.length === 0
      ? "Nothing was recorded as produced."
      : [
          ...others.map(
            (o) =>
              `- ${resolveObjectNoun(o.kind)}: ${o.title.replace(/\s+/g, " ").trim()}`
          ),
          ...(others.length && entities.length ? [""] : []),
          ...entities.flatMap((o, i) => [
            ...(i > 0 ? [""] : []),
            // THE embed writer — never a template string (ids carry no whitespace).
            serializeEmbed({
              directive: "synap-entity",
              ref: { id: o.refId.replace(/\s/g, "") },
            }),
          ]),
        ].join("\n");

  const { total, items } = input.decisions;
  const decisionsBody =
    total === 0
      ? "No proposals were decided in this session."
      : [
          `${plural(total, "proposal")} decided.`,
          "",
          ...items.map((d) => `- ${d.title} — ${resolveStatusLabel(d.status)}`),
          ...(total > items.length
            ? [`- …and ${total - items.length} more`]
            : []),
        ].join("\n");

  return [
    {
      id: CLOSING_REPORT_SECTION_IDS.outcome,
      title: "Outcome",
      body: outcomeBody,
    },
    {
      id: CLOSING_REPORT_SECTION_IDS.definitionOfDone,
      title: "Definition of done",
      body: doneBody,
      ...(verdict.state !== "none" ? { status: verdict.state } : {}),
    },
    {
      id: CLOSING_REPORT_SECTION_IDS.produced,
      title: "What was produced",
      body: producedBody,
    },
    {
      id: CLOSING_REPORT_SECTION_IDS.decisions,
      title: "Decisions",
      body: decisionsBody,
    },
  ];
}

/**
 * Does this session get a closing report? Receipts (agent-write containers)
 * and machine runs of an AUTOMATION or an intake never do. A person's work and
 * a playbook run do — when they declared criteria or produced something; a
 * session with neither has nothing structured to report.
 */
export function closingReportApplies(
  row: {
    origin: string | null;
    playbookId: string | null;
    metadata: unknown;
    status: string | null;
  },
  counts: { criteria: number; outputs: number }
): boolean {
  const kind = projectSessionKind(row);
  if (kind === "receipt") return false;
  if (kind === "run") {
    const m = (row.metadata ?? {}) as Record<string, unknown>;
    const isPlaybookRun =
      !!row.playbookId &&
      m.automationId == null &&
      m.automationRunId == null &&
      m.intake == null;
    if (!isPlaybookRun) return false;
  }
  return counts.criteria > 0 || counts.outputs > 0;
}

/**
 * Would writing `section` change the stored document? Compares the lines
 * INSIDE the fence (heading + body) and the `status` stamp — never `writtenAt`,
 * which differs on every write.
 */
export function sectionUnchanged(
  content: string,
  section: ClosingReportSection
): boolean {
  const existing = parseSections(content).sections.find(
    (s) => s.id === section.id
  );
  if (!existing) return false;
  if ((existing.attributes.status ?? "") !== (section.status ?? "")) {
    return false;
  }
  const stored = content
    .split("\n")
    .slice(existing.startLine + 1, existing.endLine)
    .join("\n");
  const next = serializeSection({
    id: section.id,
    title: section.title,
    body: section.body,
    attributes: {},
  })
    .split("\n")
    .slice(1, -1)
    .join("\n");
  return stored === next;
}

export type ClosingReportResult =
  | { status: "skipped"; reason: string }
  | {
      status: "written";
      documentId: string | null;
      written: string[];
      unchanged: string[];
      /** Sections a person has taken over — left as they are. */
      keptHuman: string[];
    };

async function loadDecisions(
  sessionId: string
): Promise<ClosingReportInput["decisions"]> {
  const where = and(
    eq(proposals.sessionId, sessionId),
    inArray(proposals.status, DECIDED_STATUSES)
  );
  const [totalRow] = await db
    .select({ n: drizzleSql<number>`count(*)::int` })
    .from(proposals)
    .where(where);
  const rows = await db
    .select({
      proposalType: proposals.proposalType,
      targetType: proposals.targetType,
      data: proposals.data,
      status: proposals.status,
    })
    .from(proposals)
    .where(where)
    .orderBy(desc(proposals.reviewedAt), desc(proposals.createdAt))
    .limit(CLOSING_REPORT_TOP_DECISIONS);
  return {
    total: Number(totalRow?.n ?? 0),
    items: rows.map((r) => ({
      // Imperative: what was PROPOSED — the status says what became of it.
      title: buildObjectActionTitle({
        action: r.proposalType,
        objectKind: r.targetType,
        objectName: extractProposalName(r.data) ?? null,
        mood: "imperative",
      }),
      status: r.status,
    })),
  };
}

/**
 * Build and write the closing report for one session. Throws on a failed read
 * or write — the caller (the close reactor) records the failure; it is never
 * reported as success.
 */
export async function writeClosingReport(
  sessionId: string
): Promise<ClosingReportResult> {
  const [row] = await db
    .select()
    .from(focusSessions)
    .where(eq(focusSessions.id, sessionId))
    .limit(1);
  if (!row) return { status: "skipped", reason: "session not found" };
  if (!isTerminalSessionStatus(row.status)) {
    return { status: "skipped", reason: "session is open again" };
  }

  const summary = await loadSessionEvaluationSummary(row);
  const outputsResult = await listSessionOutputs({
    db,
    userId: row.userId,
    sessionId: row.id,
  });
  if (!outputsResult) return { status: "skipped", reason: "session not found" };
  const documentId = await findSessionDocumentId(row.id);
  const outputs = outputsResult.outputs
    .filter((o) => o.refId !== documentId)
    .map((o) => ({ kind: o.kind, refId: o.refId, title: o.title }));

  if (
    !closingReportApplies(row, {
      criteria: summary.criteria.length,
      outputs: outputs.length,
    })
  ) {
    return { status: "skipped", reason: "no report for this kind of session" };
  }

  const report = toClosingReportInput(
    row,
    summary,
    outputs,
    await loadDecisions(row.id)
  );
  const sections = buildClosingReportSections(report);

  const written: string[] = [];
  const unchanged: string[] = [];
  const keptHuman: string[] = [];
  let writtenDocumentId = documentId;

  for (const section of sections) {
    // One retry: a concurrent writer moving the version between our read and
    // our write is a CONFLICT the door refuses cleanly — re-read and go again.
    for (let attempt = 1; ; attempt++) {
      const doc = await readSessionDocument({
        sessionId: row.id,
        userId: row.userId,
      });
      const content = doc.content ?? "";
      const existing = parseSections(content).sections.find(
        (s) => s.id === section.id
      );
      if (existing && sectionOwner(existing) === "human") {
        keptHuman.push(section.id);
        break;
      }
      if (doc.documentId && sectionUnchanged(content, section)) {
        unchanged.push(section.id);
        break;
      }
      try {
        const res = await upsertSessionDocumentSection({
          userId: row.userId,
          systemAuthor: CLOSING_REPORT_AUTHOR,
          sessionId: row.id,
          sectionId: section.id,
          title: section.title,
          body: section.body,
          ...(section.status ? { status: section.status } : {}),
          baseVersion: doc.version,
        });
        writtenDocumentId = res.documentId;
        if (res.status !== "applied") {
          throw new Error(
            `closing report section "${section.id}" was not applied (${res.status})`
          );
        }
        written.push(section.id);
        break;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "CONFLICT" && attempt < 2) continue;
        throw err;
      }
    }
  }

  return {
    status: "written",
    documentId: writtenDocumentId,
    written,
    unchanged,
    keptHuman,
  };
}

function toClosingReportInput(
  row: { status: string; verificationReport: unknown },
  summary: Awaited<ReturnType<typeof loadSessionEvaluationSummary>>,
  outputs: ClosingReportInput["outputs"],
  decisions: ClosingReportInput["decisions"]
): ClosingReportInput {
  const vr = row.verificationReport as { summary?: unknown } | null;
  return {
    status: row.status,
    summary: typeof vr?.summary === "string" ? vr.summary : null,
    criteria: summary.criteria,
    evaluations: summary.evaluations.map((e) => ({
      criterionKey: e.criterionKey,
      verdict: e.verdict,
      evaluatorKind: e.evaluatorKind,
      evaluatorId: e.evaluatorId,
      rationale: e.rationale,
    })),
    verdict: summary.verdict,
    outputs,
    decisions,
  };
}

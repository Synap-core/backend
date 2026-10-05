/**
 * What the criteria judge reads: the session's ACTUAL work, not its labels.
 *
 * The judge used to be fed the goal plus each declared output as
 * `- <label> [done]`. A criterion like "mapped with file:line evidence" can
 * never be shown by a label, so every judge check came back `unmeasured`
 * ("the material only lists 'X [done]'") and escalated to the person —
 * making judge checks near-useless once done = verdict.
 *
 * `loadProducedMaterial` reads what the session PRODUCED through the one
 * outputs join (`listSessionOutputs`, floored on the session) and pulls the
 * text of each produced document / entity through the graph's per-kind read
 * floor (`hydrationScopeWhere`) — a far end the session owner cannot see is
 * dropped, never read. `buildJudgeMaterial` packs it under a byte budget.
 *
 * A produced item whose content could not be read says so in the material
 * ("[content could not be read: …]") — never an empty body the judge would
 * read as "nothing there".
 */

import { db, documents, entities, and, inArray } from "@synap/database";
import { storage } from "@synap/storage";
import type { focusSessions } from "@synap/database";
import { listSessionOutputs } from "../session-outputs.js";
import { hydrationScopeWhere } from "../../object-graph/graph-service.js";
import type { SessionEvaluationRow } from "./record.js";
import type { PostedEvidence } from "./evaluate.js";

/** The IS route's `material` limit (`judge.ts`: `z.string().max(8000)`). */
export const MATERIAL_MAX = 8000;
const REPORT_MAX = 1200;
const EARLIER_MAX = 1200;

/** One produced thing, with the text a judge can read. */
export interface ProducedMaterial {
  kind: string;
  title: string;
  /** The declared slot it satisfies, when one matched. */
  slotLabel?: string;
  text: string;
}

const TEXT_DOC_TYPES = new Set(["markdown", "text", "code"]);

function isTextDocument(row: {
  type: string;
  mimeType: string | null;
  title: string;
}): boolean {
  if (TEXT_DOC_TYPES.has(row.type)) return true;
  if (row.mimeType?.startsWith("text/")) return true;
  if (row.mimeType === "application/json") return true;
  return /\.(md|markdown|txt)$/i.test(row.title);
}

async function documentText(row: {
  type: string;
  mimeType: string | null;
  title: string;
  storageKey: string | null;
}): Promise<string> {
  if (!row.storageKey) return "[no stored content]";
  if (!isTextDocument(row)) return `[${row.type} file — not readable as text]`;
  try {
    return (await storage.downloadBuffer(row.storageKey)).toString("utf-8");
  } catch (err) {
    return `[content could not be read: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

/**
 * The produced items of a session the owner can read, with their text. THROWS
 * when the outputs join itself fails — the caller's judge rung turns that into
 * "the judge could not run", never a verdict over labels only.
 */
export async function loadProducedMaterial(params: {
  sessionId: string;
  userId: string;
}): Promise<ProducedMaterial[]> {
  const { userId } = params;
  const joined = await listSessionOutputs({
    db,
    userId,
    sessionId: params.sessionId,
  });
  if (!joined) return [];
  const outputs = joined.outputs;

  const docIds = outputs
    .filter((o) => o.kind === "document" || o.kind === "capture")
    .map((o) => o.refId);
  const entityIds = outputs
    .filter((o) => o.kind === "entity")
    .map((o) => o.refId);

  const entityRows = entityIds.length
    ? await db
        .select({
          id: entities.id,
          title: entities.title,
          preview: entities.preview,
          properties: entities.properties,
          documentId: entities.documentId,
        })
        .from(entities)
        .where(
          and(
            inArray(entities.id, entityIds),
            hydrationScopeWhere("entity", entities, userId)
          )
        )
    : [];
  const bodyIds = entityRows
    .map((e) => e.documentId)
    .filter((id): id is string => typeof id === "string");

  const allDocIds = [...new Set([...docIds, ...bodyIds])];
  const docRows = allDocIds.length
    ? await db
        .select({
          id: documents.id,
          title: documents.title,
          type: documents.type,
          mimeType: documents.mimeType,
          storageKey: documents.storageKey,
        })
        .from(documents)
        .where(
          and(
            inArray(documents.id, allDocIds),
            hydrationScopeWhere("document", documents, userId)
          )
        )
    : [];
  const docText = new Map<string, string>();
  await Promise.all(
    docRows.map(async (d) => docText.set(d.id, await documentText(d)))
  );
  const entityById = new Map(entityRows.map((e) => [e.id, e]));

  const out: ProducedMaterial[] = [];
  for (const o of outputs) {
    const slotLabel = o.expected?.label;
    if (o.kind === "document" || o.kind === "capture") {
      const text = docText.get(o.refId);
      if (text === undefined) continue; // not visible to the owner: dropped
      out.push({ kind: o.kind, title: o.title, slotLabel, text });
    } else if (o.kind === "entity") {
      const e = entityById.get(o.refId);
      if (!e) continue;
      const props =
        e.properties && Object.keys(e.properties as object).length
          ? `PROPERTIES: ${JSON.stringify(e.properties)}`
          : "";
      const body = e.documentId ? (docText.get(e.documentId) ?? "") : "";
      out.push({
        kind: "entity",
        title: e.title ?? o.title,
        slotLabel,
        text: [e.preview ?? "", props, body].filter(Boolean).join("\n"),
      });
    } else {
      // A view / cell / url: its title is all a text judge can use.
      out.push({ kind: o.kind, title: o.title, slotLabel, text: "" });
    }
  }
  return out;
}

function clip(s: string, max: number): string {
  if (max <= 0) return "";
  return s.length <= max
    ? s
    : `${s.slice(0, Math.max(0, max - 14))}…[truncated]`;
}

/**
 * Pure: the judge's material, ≤ {@link MATERIAL_MAX} chars. The fixed facts
 * (goal, declared outputs, posted evidence, report, earlier checks) come
 * first; the produced CONTENT gets every remaining byte, split evenly.
 */
export function buildJudgeMaterial(
  session: Pick<
    typeof focusSessions.$inferSelect,
    "goal" | "expectedOutputs" | "verificationReport"
  >,
  rows: readonly Pick<
    SessionEvaluationRow,
    "criterionKey" | "verdict" | "rationale"
  >[],
  evidence: PostedEvidence | undefined,
  produced: readonly ProducedMaterial[]
): string {
  const outputs = Array.isArray(session.expectedOutputs)
    ? (session.expectedOutputs as Array<{ label?: string; status?: string }>)
    : [];
  const head = [
    `GOAL: ${session.goal}`,
    outputs.length
      ? `OUTPUTS:\n${outputs.map((o) => `- ${o.label ?? "?"} [${o.status ?? "pending"}]`).join("\n")}`
      : "",
    evidence && Object.keys(evidence).length
      ? `POSTED EVIDENCE: ${JSON.stringify(evidence)}`
      : "",
    session.verificationReport
      ? `REPORT: ${clip(JSON.stringify(session.verificationReport), REPORT_MAX)}`
      : "",
  ].filter(Boolean);
  const earlier = rows.length
    ? clip(
        `EARLIER CHECKS:\n${rows
          .map(
            (r) =>
              `- ${r.criterionKey}: ${r.verdict}${r.rationale ? ` — ${r.rationale}` : ""}`
          )
          .join("\n")}`,
        EARLIER_MAX
      )
    : "";

  let producedPart = "";
  if (produced.length) {
    const heading = "PRODUCED (the content of what this session made):";
    const fixed = [...head, earlier].filter(Boolean).join("\n\n").length;
    const headers = produced.map(
      (p) =>
        `### ${p.kind}: ${p.title}${p.slotLabel ? ` (for "${p.slotLabel}")` : ""}`
    );
    const overhead =
      heading.length + headers.reduce((n, h) => n + h.length + 2, 0) + 8;
    const budget = MATERIAL_MAX - fixed - overhead;
    const each = Math.floor(Math.max(0, budget) / produced.length);
    producedPart = [
      heading,
      ...produced.map((p, i) =>
        p.text ? `${headers[i]}\n${clip(p.text, each)}` : headers[i]
      ),
    ].join("\n");
  }

  return [...head, producedPart, earlier]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, MATERIAL_MAX);
}

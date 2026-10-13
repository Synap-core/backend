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
 *
 * `loadRoomMaterial` adds the session ROOM: its latest human + agent messages
 * (evidence is often posted there, never in a document), read as the session
 * owner through the one history door. A room the owner cannot read ("room not
 * readable") or a failed read ("room unavailable") is written into the
 * material, never silently omitted.
 *
 * Budget: every produced item and the room get a FAIR share (water-filling —
 * a short section keeps all of its text, what it leaves is re-split among the
 * rest), so a long first document can no longer starve a later one. A clipped
 * document keeps its head AND its tail (conclusions and logs land at the
 * end); a clipped room keeps its newest messages. Every cut says `[truncated]`.
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  documents,
  entities,
  messages,
  MessageAuthorType,
  and,
  inArray,
} from "@synap/database";
import { storage } from "@synap/storage";
import { queryChannelMessages } from "../../../utils/query-channel-messages.js";
import type { focusSessions } from "@synap/database";
import { listSessionOutputs } from "../session-outputs.js";
import { hydrationScopeWhere } from "../../object-graph/graph-service.js";
import type { SessionEvaluationRow } from "./record.js";
import type { PostedEvidence } from "./evaluate.js";

/**
 * PINNED to the IS route's `material` limit (synap-intelligence-service
 * `routes/session-intelligence/judge.ts`: `JUDGE_MATERIAL_MAX`). The repos
 * cannot import each other, so the two are kept equal by hand — raise the IS
 * value FIRST and deploy the IS before this; a larger material is a 400 there.
 */
export const MATERIAL_MAX = 16_000;
/**
 * The cap of an IS deployed before the raise (≤ aef1dd82). A judge call the IS
 * refuses as a bad request is retried ONCE with material rebuilt at this size
 * (`evaluate.ts`), so a pod deployed ahead of its IS still gets graded.
 */
export const LEGACY_IS_MATERIAL_MAX = 8_000;
const REPORT_MAX = 1200;
const EARLIER_MAX = 1200;
/** How many of the room's latest messages the judge reads. */
export const ROOM_MESSAGES_N = 20;
const ROOM_MESSAGE_MAX = 800;
const TRUNCATED = "…[truncated]…";

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

/**
 * The session room's latest human + agent messages, oldest → newest. `ok` with
 * no messages is a true empty (no room, or nothing said); `refused` is a room
 * the session owner cannot read (a `channelId` pointed at someone else's
 * conversation) — the judge is told so and never sees it; `failed` is a read
 * that did not happen, and the material says so.
 */
export type RoomMaterial =
  | { status: "ok"; messages: Array<{ author: string; text: string }> }
  | { status: "refused" }
  | { status: "failed"; reason: string };

/**
 * The room of a session, read AS ITS OWNER through the one history door
 * (`queryChannelMessages` with `userId`: the canonical channel read floor,
 * plus the deleted / ephemeral filters). A session's `channelId` is a pointer,
 * not a grant — the room is read only when the owner can read that channel.
 * System / bot notices are noise, not evidence, and are left out.
 */
export async function loadRoomMaterial(params: {
  channelId: string | null;
  userId: string;
}): Promise<RoomMaterial> {
  const { channelId, userId } = params;
  if (!channelId) return { status: "ok", messages: [] };
  try {
    const rows = await queryChannelMessages<{
      authorType: string;
      content: string;
    }>(db, {
      channelId,
      userId,
      order: "desc",
      limit: ROOM_MESSAGES_N,
      columns: { authorType: true, content: true },
      extraWhere: inArray(messages.authorType, [
        MessageAuthorType.HUMAN,
        MessageAuthorType.AI_AGENT,
      ]),
    });
    return {
      status: "ok",
      messages: rows.reverse().map((r) => ({
        author: r.authorType === MessageAuthorType.HUMAN ? "person" : "agent",
        text: clip(r.content, ROOM_MESSAGE_MAX),
      })),
    };
  } catch (err) {
    if (err instanceof TRPCError && err.code === "NOT_FOUND")
      return { status: "refused" };
    return {
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * ≤ `max` chars. `ends` keeps the head and the tail (a document's verdict and
 * logs are often at its end); `tail` keeps only the end (the newest messages).
 */
function clip(s: string, max: number, keep: "ends" | "tail" = "ends"): string {
  if (s.length <= max) return s;
  const room = max - TRUNCATED.length;
  if (room <= 0) return max > 0 ? TRUNCATED.slice(0, max) : "";
  if (keep === "tail") return `${TRUNCATED}${s.slice(s.length - room)}`;
  const head = Math.ceil(room / 2);
  return `${s.slice(0, head)}${TRUNCATED}${s.slice(s.length - (room - head))}`;
}

/**
 * Pure: split `budget` across texts so none starves another — the shortest
 * keep everything, the rest share what is left evenly (water-filling).
 */
export function fairShares(
  lengths: readonly number[],
  budget: number
): number[] {
  const shares = new Array<number>(lengths.length).fill(0);
  let left = Math.max(0, budget);
  const order = lengths
    .map((n, i) => [n, i] as const)
    .sort((a, b) => a[0] - b[0]);
  order.forEach(([n, i], k) => {
    const share = Math.min(n, Math.floor(left / (order.length - k)));
    shares[i] = share;
    left -= share;
  });
  return shares;
}

/**
 * Pure: the judge's material, ≤ `max` chars ({@link MATERIAL_MAX} unless the
 * caller is retrying for an older IS). The fixed facts
 * (goal, declared outputs, posted evidence, report, prior verdicts) come
 * first; the produced CONTENT and the session room share every remaining
 * byte through {@link fairShares}. `judgedKeys` = the criteria being graded in
 * this call; their own earlier verdicts are withheld.
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
  produced: readonly ProducedMaterial[],
  room: RoomMaterial = { status: "ok", messages: [] },
  max: number = MATERIAL_MAX,
  judgedKeys: ReadonlySet<string> = new Set()
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
  // A judge must never read its own earlier verdict (a retry would cite it
  // as proof): the criteria being graded NOW are dropped. What stays are the
  // other criteria's recorded results — context about the session, framed as
  // NOT evidence (the IS judge prompt says the same).
  const priorRows = rows.filter((r) => !judgedKeys.has(r.criterionKey));
  const earlier = priorRows.length
    ? clip(
        `PRIOR VERDICTS ON OTHER CRITERIA (context, NOT evidence — never grade from these):\n${priorRows
          .map(
            (r) =>
              `- ${r.criterionKey}: ${r.verdict}${r.rationale ? ` — ${r.rationale}` : ""}`
          )
          .join("\n")}`,
        EARLIER_MAX
      )
    : "";

  // Every section that carries content competes for one budget, fairly.
  const producedHeading = "PRODUCED (the content of what this session made):";
  const headers = produced.map(
    (p) =>
      `### ${p.kind}: ${p.title}${p.slotLabel ? ` (for "${p.slotLabel}")` : ""}`
  );
  const roomHeading =
    room.status === "failed"
      ? `SESSION ROOM: unavailable — the room could not be read (${room.reason}).`
      : room.status === "refused"
        ? "SESSION ROOM: not readable — the session owner cannot read this room."
        : room.messages.length
          ? `SESSION ROOM (latest ${room.messages.length} messages, oldest first):`
          : "";
  const roomText =
    room.status === "ok"
      ? room.messages.map((m) => `[${m.author}] ${m.text}`).join("\n")
      : "";
  const texts = [...produced.map((p) => p.text), roomText];
  const fixed = [...head, earlier].filter(Boolean).join("\n\n").length;
  const overhead =
    (produced.length ? producedHeading.length + 2 : 0) +
    headers.reduce((n, h) => n + h.length + 1, 0) +
    (roomHeading ? roomHeading.length + 3 : 0) +
    texts.filter(Boolean).length +
    8;
  const shares = fairShares(
    texts.map((t) => t.length),
    max - fixed - overhead
  );

  const producedPart = produced.length
    ? [
        producedHeading,
        ...produced.map((p, i) =>
          p.text ? `${headers[i]}\n${clip(p.text, shares[i]!)}` : headers[i]
        ),
      ].join("\n")
    : "";
  const roomPart = roomText
    ? `${roomHeading}\n${clip(roomText, shares[produced.length]!, "tail")}`
    : roomHeading;

  return [...head, producedPart, roomPart, earlier]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, max);
}

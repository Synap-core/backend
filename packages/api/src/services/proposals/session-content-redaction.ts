/**
 * REDACT AT READ — a proposal that targets a session the viewer may not read
 * (decision D1, 2026-09-26: a session's title/goal/status/progress is CONTENT).
 *
 * Session proposals copy session content into the row at WRITE time:
 * `resolveProposalTargetName` stamps the goal as `data.targetName`, and
 * `completeFocusSession` files `{ goal, status, previousStatus,
 * sessionSummary, verificationReport }` as the proposal's data. The proposal
 * itself stays visible under its OWN rule (workspace reviewers), so the copy
 * must be withheld where it is READ — nothing is rewritten, and rows written
 * before this existed are covered by construction.
 *
 * ALLOWLIST, not denylist: for a withheld target only the structural envelope
 * survives (who filed it, which verb, which id) and the inner payload keeps
 * nothing but `id`. A new content key a producer adds tomorrow is withheld
 * without anyone remembering to list it. `targetName` becomes the vocabulary
 * placeholder. `revisionHistory` keeps who/when, never the before/patch values.
 *
 * Only a target that EXISTS and is unreadable is redacted: a proposal to START
 * a session (target not yet created) is the proposer's own content.
 *
 * Every proposal read door runs rows through this ONE function:
 * `enrichProposalsForDisplay` (tRPC list/get, Hub `GET /proposals/:id`, MCP
 * `get_proposal`), `proposals.groups`, Hub `listProposals`, MCP
 * `list_proposals`.
 */
import { db, and, inArray } from "@synap/database";
import { focusSessions } from "@synap/database/schema";
import { isLikelyUUID } from "@synap-core/types/proposals";
import { resolvePrivateObjectLabel } from "@synap-core/types/vocabulary";
import {
  sessionReadableWhere,
  type SessionReader,
} from "../../access/session-visibility.js";

/** The target types a proposal uses for a focus session. */
const SESSION_TARGET_TYPES = new Set(["focus_session", "session"]);

/** Envelope keys that name the REQUEST, never the session's content. */
const ENVELOPE_KEEP = [
  "requestId",
  "source",
  "sourceId",
  "targetType",
  "targetId",
  "changeType",
  "requestedEventId",
  "validatedEventId",
  "_autoApprove",
] as const;

interface RedactableRow {
  targetType: string;
  targetId: string | null;
  data: unknown;
  revisionHistory?: unknown;
}

function pick(
  record: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in record) out[k] = record[k];
  return out;
}

function redactData(raw: unknown): Record<string, unknown> {
  const record =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const inner =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : null;
  const out = pick(record, ENVELOPE_KEEP);
  if (inner) out.data = pick(inner, ["id"]);
  else if ("id" in record) out.id = record.id;
  out.targetName = resolvePrivateObjectLabel("session");
  return out;
}

function redactHistory(history: unknown): unknown {
  if (!Array.isArray(history)) return history;
  return history.map((entry) =>
    entry && typeof entry === "object"
      ? {
          ...pick(entry as Record<string, unknown>, ["at", "by"]),
          before: {},
          patch: {},
        }
      : entry
  );
}

/** The session ids a proposal names as its SUBJECT (a session target). */
function targetSessionIds(
  rows: readonly Pick<RedactableRow, "targetType" | "targetId">[]
): string[] {
  return rows
    .filter((r) => SESSION_TARGET_TYPES.has(r.targetType))
    .map((r) => r.targetId)
    .filter((id): id is string => !!id && isLikelyUUID(id));
}

/**
 * The sessions a proposal belongs to: the run it was filed in (`session_id`)
 * and its subject when it targets a session. ONE definition for both gates
 * that key on "the proposal's session" — the decide gate below and the
 * comment gate (`assertProposalCommentableBy`).
 */
export function proposalSessionIds(row: {
  targetType: string;
  targetId: string | null;
  sessionId: string | null;
}): string[] {
  const ids = targetSessionIds([row]);
  if (row.sessionId && isLikelyUUID(row.sessionId)) ids.push(row.sessionId);
  return [...new Set(ids)];
}

/** Of `ids`, those that EXIST and `reader` may not read. Two batched selects. */
async function unreadableSessionIds(
  ids: readonly string[],
  reader: SessionReader
): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Set();
  const [existing, readable] = await Promise.all([
    db
      .select({ id: focusSessions.id })
      .from(focusSessions)
      .where(inArray(focusSessions.id, unique)),
    db
      .select({ id: focusSessions.id })
      .from(focusSessions)
      .where(
        and(inArray(focusSessions.id, unique), sessionReadableWhere(reader))
      ),
  ]);
  const ok = new Set(readable.map((r) => r.id));
  return new Set(existing.map((r) => r.id).filter((id) => !ok.has(id)));
}

/** The session ids these rows TARGET that exist and `reader` may not read. */
export async function unreadableTargetSessionIds(
  rows: readonly Pick<RedactableRow, "targetType" | "targetId">[],
  reader: SessionReader
): Promise<Set<string>> {
  return unreadableSessionIds(targetSessionIds(rows), reader);
}

/**
 * THE definition of "a proposal about a session the viewer cannot read" for
 * the DECIDE gate (founder decision 2026-09-27: nobody decides what they cannot
 * read): every existing session in `proposalSessionIds` of these rows that
 * `reader` may not read. A row is undecidable when ANY of its sessions is in
 * the returned set.
 *
 * Wider than redaction on purpose: redaction withholds only a session TARGET's
 * copied content, because only that row carries session content. A proposal
 * FILED in a private run (`session_id`) keeps its own content visible to its
 * reviewers, but deciding it still needs a reader of that run.
 */
export async function unreadableProposalSessionIds(
  rows: readonly {
    targetType: string;
    targetId: string | null;
    sessionId: string | null;
  }[],
  reader: SessionReader
): Promise<Set<string>> {
  return unreadableSessionIds(rows.flatMap(proposalSessionIds), reader);
}

/**
 * Rows unchanged, except those targeting a session `reader` may not read,
 * whose session content is withheld (see module doc). Order preserved.
 */
export async function redactUnreadableSessionTargets<R extends RedactableRow>(
  rows: R[],
  reader: SessionReader
): Promise<R[]> {
  const hidden = await unreadableTargetSessionIds(rows, reader);
  if (hidden.size === 0) return rows;
  return rows.map((row) =>
    row.targetId && hidden.has(row.targetId)
      ? {
          ...row,
          data: redactData(row.data),
          ...("revisionHistory" in row
            ? { revisionHistory: redactHistory(row.revisionHistory) }
            : {}),
        }
      : row
  );
}

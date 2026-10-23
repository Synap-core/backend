/**
 * WHERE THIS CALL'S WRITES LANDED — the session block of an MCP write reply
 * (B4 2026-10-21).
 *
 * The agent used to learn nothing about grouping: its ICP write went into a
 * session called "Ecosystem market intelligence foundation" and it never knew.
 * The governance gate records every filing (`recordWriteSessionFiling`, the
 * request ledger) and this turns the ledger into what the reply carries:
 *
 *  - `filedIn[]`: each session a write was filed under, by id and NAME
 *    (`resolveSessionTitle`, the one display resolver).
 *  - `topicHint`: a session the client STARTED never splits (founder rule c);
 *    when a write's project is not that session's project, the reply says so
 *    and suggests a new session. Only when BOTH projects are known: a session
 *    with no project is general work, not a different topic.
 *
 * Built from what the gate RECORDED, never from a guess made before the
 * handler ran. A failed read is reported as `unavailable`, never as "no
 * session".
 */
import {
  db,
  and,
  eq,
  inArray,
  focusSessions,
  projects,
  type WriteSessionFiling,
} from "@synap/database";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import { createLogger } from "@synap-core/core";
import { getAgentFocusProjectId } from "../../services/agent-identity-service.js";

const logger = createLogger({ module: "mcp/write-session-report" });

export interface FiledInSession {
  sessionId: string;
  title: string;
  /** `receipt` = grouped for you (splits by project); `session` = one you started or named. */
  kind: "receipt" | "session";
}

export interface SessionTopicHint {
  sessionId: string;
  sessionTitle: string;
  sessionProject: { id: string; name: string | null };
  writeProject: { id: string; name: string | null };
  suggest: "synap_start_session";
}

export type WriteSessionReport =
  | { status: "ok"; filedIn: FiledInSession[]; topicHint?: SessionTopicHint }
  | { status: "unavailable" };

export async function describeWriteSessions(
  filings: readonly WriteSessionFiling[],
  caller: { userId: string; agentUserId?: string }
): Promise<WriteSessionReport | undefined> {
  if (filings.length === 0) return undefined;
  try {
    const ids = [...new Set(filings.map((f) => f.sessionId))];
    const rows = await db
      .select({
        id: focusSessions.id,
        title: focusSessions.title,
        goal: focusSessions.goal,
        projectId: focusSessions.projectId,
        metadata: focusSessions.metadata,
      })
      .from(focusSessions)
      .where(
        and(
          inArray(focusSessions.id, ids),
          eq(focusSessions.userId, caller.userId)
        )
      );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const isReceipt = (metadata: unknown) =>
      (metadata as { autoOpened?: unknown } | null)?.autoOpened === true;
    const filedIn: FiledInSession[] = ids.flatMap((id) => {
      const row = byId.get(id);
      return row
        ? [
            {
              sessionId: id,
              title: resolveSessionTitle(row),
              kind: isReceipt(row.metadata)
                ? ("receipt" as const)
                : ("session" as const),
            },
          ]
        : [];
    });

    // The write's project: what the gate recorded, else the conversation's
    // declared focus — the same ladder the receipt key uses.
    const needsFocus = filings.some((f) => f.projectId === null);
    const focusProjectId =
      needsFocus && caller.agentUserId
        ? await getAgentFocusProjectId(caller.agentUserId)
        : null;
    let hint: SessionTopicHint | undefined;
    for (const f of filings) {
      const row = byId.get(f.sessionId);
      const writeProjectId = f.projectId ?? focusProjectId;
      if (
        !row ||
        isReceipt(row.metadata) ||
        !row.projectId ||
        !writeProjectId ||
        row.projectId === writeProjectId
      ) {
        continue;
      }
      const named = await db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(inArray(projects.id, [row.projectId, writeProjectId]));
      const nameOf = (id: string) =>
        named.find((p) => p.id === id)?.name ?? null;
      hint = {
        sessionId: row.id,
        sessionTitle: resolveSessionTitle(row),
        sessionProject: { id: row.projectId, name: nameOf(row.projectId) },
        writeProject: { id: writeProjectId, name: nameOf(writeProjectId) },
        suggest: "synap_start_session",
      };
      break;
    }
    return { status: "ok", filedIn, ...(hint ? { topicHint: hint } : {}) };
  } catch (err) {
    logger.warn({ err }, "write session report unavailable");
    return { status: "unavailable" };
  }
}

/** The one-line Note for a topic hint — said in words, once per session+project. */
export function topicHintNote(hint: SessionTopicHint): string {
  const write = hint.writeProject.name
    ? `"${hint.writeProject.name}"`
    : "another project";
  const session = hint.sessionProject.name
    ? `"${hint.sessionProject.name}"`
    : "its own project";
  return (
    `Note: this write is about ${write}, but your session "${hint.sessionTitle}" ` +
    `is about ${session}. It was filed there anyway. If this is new work, start a ` +
    `session for it with synap_start_session; to rename the current one, use ` +
    `synap_update_session { title }.`
  );
}

const HINTED_MAX = 500;
const hinted = new Set<string>();

/** True the first time this process sees (session, write project); bounded. */
export function firstTopicHint(hint: SessionTopicHint): boolean {
  const key = `${hint.sessionId}|${hint.writeProject.id}`;
  if (hinted.has(key)) return false;
  if (hinted.size >= HINTED_MAX) hinted.clear();
  hinted.add(key);
  return true;
}

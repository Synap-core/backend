/**
 * SESSION RECALL — the ONE reader of what recall left on a session.
 *
 * When a session starts, the pod looks for raw captures and notes that could
 * help it (api `services/focus-sessions/session-recall.ts`, the runner) and
 * writes its result onto `focus_sessions.metadata`:
 *   `recalled: RecalledItem[]`, `recalledAt`, `recallError?`, `recallSkipped?`.
 * Every surface (pod MCP + Hub + tRPC `focusSessions.get` `recall`, web, relay,
 * the intelligence service) reads it through {@link projectSessionRecall}, so
 * the five states can never fold into one another — above all, a FAILED recall
 * never reads as "nothing found".
 *
 *   pending   recall has not run yet (no `recalledAt`)
 *   ok        it found items (`recalled` non-empty)
 *   empty     it ran and found nothing
 *   skipped   it deliberately did not run (`recallSkipped`): a session an
 *             automation started (cost), or a shared session with no
 *             workspace to recall from (privacy)
 *   failed    it errored (`recallError`); what an EARLIER run found is kept
 *
 * Pure and dependency-free (web, relay, Electron, Node, IS).
 */

export interface RecalledItem {
  entityId: string;
  title: string;
  kind: string;
  /** 0..1, two decimals — the candidate's own evidence. */
  score: number;
  /** One human line: why this was recalled. */
  reason: string;
  recalledAt: string;
}

/** Why recall deliberately did not run on a session. */
export type RecallSkipReason =
  /** Started by an automation with no person (cost); a manual recall still runs. */
  | "automation"
  /** Others can read the session and it has no workspace to recall from. */
  | "shared_without_workspace";

export const RECALL_SKIP_REASONS: readonly RecallSkipReason[] = [
  "automation",
  "shared_without_workspace",
];

export type SessionRecallView =
  | { status: "pending" }
  | { status: "ok"; recalled: RecalledItem[]; recalledAt: string }
  | { status: "empty"; recalledAt: string }
  | { status: "skipped"; reason: RecallSkipReason; recalledAt: string }
  | {
      status: "failed";
      error: string;
      recalledAt: string;
      /** What an EARLIER run found, kept across the failure. */
      recalled: RecalledItem[];
    };

function readItems(raw: unknown): RecalledItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is RecalledItem =>
      !!r &&
      typeof r === "object" &&
      typeof (r as RecalledItem).entityId === "string" &&
      typeof (r as RecalledItem).title === "string"
  );
}

/** The session's metadata → its recall state. Never throws. */
export function projectSessionRecall(metadata: unknown): SessionRecallView {
  const m = (
    metadata && typeof metadata === "object" ? metadata : {}
  ) as Record<string, unknown>;
  const at = typeof m.recalledAt === "string" ? m.recalledAt : null;
  if (!at) return { status: "pending" };
  const recalled = readItems(m.recalled);
  const err = m.recallError as { message?: unknown } | null | undefined;
  if (err && typeof err === "object") {
    return {
      status: "failed",
      error: typeof err.message === "string" ? err.message : "unknown",
      recalledAt: at,
      recalled,
    };
  }
  const skipped = m.recallSkipped;
  if (
    typeof skipped === "string" &&
    (RECALL_SKIP_REASONS as readonly string[]).includes(skipped)
  ) {
    return {
      status: "skipped",
      reason: skipped as RecallSkipReason,
      recalledAt: at,
    };
  }
  return recalled.length > 0
    ? { status: "ok", recalled, recalledAt: at }
    : { status: "empty", recalledAt: at };
}

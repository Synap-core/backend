/**
 * Name the turn's session for the agent — SERVER-OWNED.
 *
 * `turnContext.session` arrives from the caller with the goal stack's ids and
 * goals. Its NAME is the pod's to say: the stored title through
 * `resolveSessionTitle` (the one naming rule every surface shows), so the IS
 * prompt says "You are working on: <name>" instead of quoting a goal paragraph.
 * The caller cannot supply `title` (the wire schema is strict); only this adds
 * it, and only for a session the caller owns.
 *
 * Best-effort: a failed read leaves the context exactly as the caller sent it
 * (the IS then narrates the goal, as before) — naming is a nicety, never a
 * reason to fail a turn.
 */
import { db, focusSessions, and, eq } from "@synap/database";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "focus-sessions/turn-context-title" });

export async function withTurnSessionTitle<
  T extends { session?: { id: string } & Record<string, unknown> },
>(turnContext: T, userId: string): Promise<T> {
  const session = turnContext.session;
  if (!session?.id) return turnContext;
  try {
    const [row] = await db
      .select({ title: focusSessions.title, goal: focusSessions.goal })
      .from(focusSessions)
      .where(
        and(eq(focusSessions.id, session.id), eq(focusSessions.userId, userId))
      )
      .limit(1);
    if (!row) return turnContext;
    const title = resolveSessionTitle(row);
    return title
      ? { ...turnContext, session: { ...session, title } }
      : turnContext;
  } catch (err) {
    logger.warn(
      { err, sessionId: session.id },
      "turn session title read failed — the agent sees the goal instead"
    );
    return turnContext;
  }
}

/**
 * THE SESSION A WRITE REPLY ECHOES — what an agent acts on after it started,
 * updated or closed a session, never the whole row.
 *
 * Measured over 24 days of MCP replies (reply shaping, 2026-11-05): the full
 * row was 97 % of every `synap_update_session` reply (~1,323 tokens mean over
 * 2,503 calls), ~1,114 tokens of every `synap_complete_session` reply and ~434
 * of every `synap_start_session` reply. Most of it is what the agent itself
 * just sent (goal, criteria statements, slot asks) or what it never reads on a
 * write (metadata, stage history, verification report).
 *
 * Kept: the identity and state an agent continues from: the id, the room
 * (`channelId`, where it posts), status, step, progress, where the session is
 * filed (track, project, space), what it follows and is about. A start also
 * names the outcome and criterion KEYS: the pod derives a key from a label
 * and a playbook brings its own, so the start reply is where the agent learns
 * the keys `completeOutput` and `evaluate_session` take. What is still owed
 * rides `nudges`; the whole row is one `synap_get_session` away.
 *
 * Consumers checked (synap-bridge, synap-cli, synap-app, browser, relay-app,
 * intelligence service, control plane): the bridge reads `session.id` from a
 * start reply (`startedSessionId`, hooks/lib.ts) and `blockerLinks` from an
 * update reply (hooks/register.tsx); both stay. Nothing outside backend reads
 * another field of these replies.
 */
import type { ExpectedOutput, SessionCriterion } from "@synap/playbooks";

/** The row fields every echo carries, in this order. */
export const SESSION_ECHO_FIELDS = [
  "id",
  "title",
  "status",
  "currentStage",
  "progress",
  "channelId",
  "trackId",
  "projectId",
  "workspaceId",
  "playbookId",
  "subjectEntityId",
  "updatedAt",
] as const;

type EchoField = (typeof SESSION_ECHO_FIELDS)[number];

export type SessionWriteEcho = Partial<Record<EchoField, unknown>> & {
  /** Start only: each outcome's key, label and status. */
  outcomes?: Array<{
    key: string | undefined;
    label: string;
    status: ExpectedOutput["status"];
    owner?: "human";
  }>;
  /** Start only: the criterion keys `evaluate_session` grades. */
  criteria?: string[];
};

/**
 * Project a session row onto the echo. `withKeys` (start) adds the outcome
 * and criterion keys. Fields the row does not carry are left out, never
 * invented.
 */
export function sessionWriteEcho(
  row: object,
  opts: { withKeys?: boolean } = {}
): SessionWriteEcho {
  const session = row as Record<string, unknown>;
  const echo: SessionWriteEcho = {};
  for (const f of SESSION_ECHO_FIELDS) {
    if (session[f] !== undefined) echo[f] = session[f];
  }
  if (opts.withKeys) {
    const slots = Array.isArray(session.expectedOutputs)
      ? (session.expectedOutputs as ExpectedOutput[])
      : [];
    if (slots.length > 0) {
      echo.outcomes = slots.map((s) => ({
        key: s.key,
        label: s.label,
        status: s.status,
        ...(s.owner === "human" ? { owner: "human" as const } : {}),
      }));
    }
    const criteria = Array.isArray(session.criteria)
      ? (session.criteria as SessionCriterion[])
      : [];
    if (criteria.length > 0) echo.criteria = criteria.map((c) => c.key);
  }
  return echo;
}

/**
 * WHICH AGENT STARTED a session — a stored fact, never the roster's order.
 *
 * The agent that starts a session is put on its roster (`createFocusSession`,
 * `openRunSession`, an agent's playbook run), so `agentIds` alone cannot tell
 * work handed to an agent from work it started itself. Orient's `handedToYou`
 * needs exactly that difference (plan v2 S8, "computers and adjuncts"): a
 * worker sharing an identity with an interactive session must not launch on
 * every session the interactive one starts.
 *
 * Every door that seeds the roster with its ACTING agent stamps
 * `metadata.startedByAgentId`. A session stamped before this existed has no
 * stamp; for it the client key the start was made with
 * (`metadata.clientKey`, `clientKeyForApiKey`) still names the agent when it is
 * `agent:<id>` or one of that agent's keys (`key:<apiKeyId>…`). A session with
 * neither reads as handed, which is what every reader did before.
 */
import { sql as drizzleSql, type SQL } from "drizzle-orm";
import { focusSessions } from "../schema/focus-sessions.js";

/** `focus_sessions.metadata` key: the agent user that started the session. */
export const SESSION_STARTED_BY_AGENT_KEY = "startedByAgentId";

/** The metadata stamp for a session `agentUserId` starts (`{}` for a person). */
export function startedByAgentPatch(
  agentUserId: string | null | undefined
): Record<string, string> {
  return agentUserId ? { [SESSION_STARTED_BY_AGENT_KEY]: agentUserId } : {};
}

/** SQL boolean: `agentUserId` started the `focus_sessions` row in scope. */
export function sessionStartedByAgentSql(agentUserId: string): SQL {
  const meta = focusSessions.metadata;
  return drizzleSql`(
    ${meta} ->> ${SESSION_STARTED_BY_AGENT_KEY} = ${agentUserId}
    OR (
      ${meta} ->> ${SESSION_STARTED_BY_AGENT_KEY} IS NULL
      AND (
        ${meta} ->> 'clientKey' = ${`agent:${agentUserId}`}
        OR EXISTS (
          SELECT 1 FROM api_keys sb_k
          WHERE sb_k.user_id = ${agentUserId}
            AND sb_k.id::text = split_part(split_part(${meta} ->> 'clientKey', '|', 1), 'key:', 2)
        )
      )
    )
  )`;
}

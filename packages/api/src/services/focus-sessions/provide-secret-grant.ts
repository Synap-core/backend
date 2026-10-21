/**
 * A SECRET handed over for an ask is one act of consent, not two: the person
 * who answers also lets the agent that ASKED read it, for this session only
 * (`scope: 'session'`, {@link PROVIDE_SECRET_GRANT_MINUTES} minutes). Without
 * this the agent holds a `vault://` reference it cannot read and must file
 * `vault.request`, which the person approves a second time.
 *
 * WHO ASKED is read from the durable record of the ask as posed
 * (`focus_session.slot_asked.completed`, `slot-asked-event.ts`): the FIRST row
 * for this slot whose fingerprint is the ask being answered since the slot was
 * last answered (`slot_answered`), written by the door that posed it with the
 * authenticated agent. The first, so a second agent re-posing the identical
 * ask later never takes the read. Nothing a client sends names the grantee:
 * the answer may only CONFIRM it (`expectedGranteeId`, the agent the person
 * was shown by `provideOptions`), and a different asker then gets nothing
 * (`agent_changed`). No such row, a row with no agent (a person posed it, or
 * the decision reactor did), or a row naming something that is not an agent
 * user: the agent is UNKNOWN and no read is granted. The hand-over itself
 * still stands: a reference gives nobody the value, and the agent can still ask
 * through the vault's request door.
 *
 * The read is THIS SESSION's: its grant id is kept on the session
 * (`metadata.provideGrants`) and revoked when the session closes
 * ({@link revokeSessionProvidedGrants}), or ends with its TTL first.
 *
 * The grant goes through the ONE grant writer (`applyVaultSecretGrant`),
 * bound to the agent (`grantedTo`) and to no workspace: the agent redeems it
 * wherever it works, and nobody else can.
 */

import {
  db,
  and,
  eq,
  desc,
  inArray,
  notInArray,
  isNull,
  drizzleSql,
  users,
  focusSessions,
  assertGrantScoped,
} from "@synap/database";
import { events, secrets, vaultGrants } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import {
  PROVIDE_SECRET_GRANT_MINUTES,
  type ProvideSecretGrant,
  type ProvideSecretGrantRefusal,
} from "@synap-core/types/ask";
import { auditLog } from "../../utils/audit-log.js";
import { grantWriteDenial } from "../../utils/grant-write-check.js";
import {
  applyVaultSecretGrant,
  revokeVaultSecretGrant,
} from "../vault-secret-grant.js";
import { agentDisplayName } from "../agent-dispatch/binding-call.js";
import { normalizeExpectedLabel } from "./expected-label.js";
import {
  FOCUS_SESSION_SUBJECT_TYPE,
  FOCUS_SESSION_SLOT_ASKED_EVENT_TYPE,
  FOCUS_SESSION_SLOT_ANSWERED_EVENT_TYPE,
} from "./lifecycle-events.js";
import { PROVIDE_GRANTS_META_KEY } from "./session-metadata.js";
import { TERMINAL_SESSION_STATUSES } from "./session-statuses.js";
import { assertFreshAuthentication } from "../../utils/device-session.js";

const logger = createLogger({ module: "provide-secret-grant" });

/** How far back the asker read looks: one slot is asked a handful of times. */
const SLOT_ASKED_SCAN = 50;

interface SlotHistoryRow {
  type: string;
  data: Record<string, unknown>;
}

/**
 * The agent id of the FIRST ask with this fingerprint since the slot was last
 * answered, from the slot's history newest-first. Pure.
 */
export function firstAskerSinceAnswered(
  rowsNewestFirst: readonly SlotHistoryRow[],
  expectedLabel: string,
  fingerprint: string
): string | null {
  const wanted = normalizeExpectedLabel(expectedLabel);
  let first: Record<string, unknown> | null = null;
  for (const row of rowsNewestFirst) {
    const d = row.data;
    if (
      normalizeExpectedLabel(d.expectedLabel as string | undefined) !== wanted
    ) {
      continue;
    }
    if (row.type === FOCUS_SESSION_SLOT_ANSWERED_EVENT_TYPE) break;
    if (d.askFingerprint === fingerprint) first = d;
  }
  return typeof first?.askedByAgentUserId === "string"
    ? first.askedByAgentUserId
    : null;
}

export interface AskingAgent {
  agentUserId: string;
  agentName: string;
}

/**
 * The agent that posed THIS ask on the slot, or `null` when the pod cannot
 * name one. A failed read is `null` too (logged): an unreadable record must
 * never become a grant.
 */
export async function resolveAskingAgent(p: {
  sessionId: string;
  expectedLabel: string;
  askFingerprint: string;
}): Promise<AskingAgent | null> {
  try {
    const rows = await db
      .select({ type: events.type, data: events.data })
      .from(events)
      .where(
        and(
          eq(events.subjectType, FOCUS_SESSION_SUBJECT_TYPE),
          eq(events.subjectId, p.sessionId),
          inArray(events.type, [
            FOCUS_SESSION_SLOT_ASKED_EVENT_TYPE,
            FOCUS_SESSION_SLOT_ANSWERED_EVENT_TYPE,
          ])
        )
      )
      .orderBy(desc(events.timestamp))
      .limit(SLOT_ASKED_SCAN);
    const agentUserId = firstAskerSinceAnswered(
      rows.map((r) => ({
        type: r.type,
        data: (r.data ?? {}) as Record<string, unknown>,
      })),
      p.expectedLabel,
      p.askFingerprint
    );
    if (!agentUserId) return null;
    const [agent] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, agentUserId), eq(users.userType, "agent")))
      .limit(1);
    if (!agent) return null;
    return { agentUserId, agentName: await agentDisplayName(agentUserId) };
  } catch (err) {
    logger.error(
      { err, sessionId: p.sessionId },
      "could not read who posed the ask — no read is granted"
    );
    return null;
  }
}

/** What the answer door will do about the agent's read, decided BEFORE it commits. */
export type SecretGrantPlan =
  | { status: "grant"; agent: AskingAgent }
  | { status: "refused"; reason: ProvideSecretGrantRefusal };

export async function planProvidedSecretGrant(p: {
  sessionId: string;
  expectedLabel: string;
  askFingerprint: string;
  secretId: string;
  /** The agent the person was shown (`provideOptions`); absent = not checked. */
  expectedGranteeId?: string;
}): Promise<SecretGrantPlan> {
  // A key that answers may not hand out more than its own grant allows: the
  // same rung the direct grant door applies (`vault.grant`).
  if (await grantWriteDenial({ subjectType: "vault", action: "grant" })) {
    return { status: "refused", reason: "key_not_allowed" };
  }
  const [secret] = await db
    .select({ encryptionMode: secrets.encryptionMode })
    .from(secrets)
    .where(eq(secrets.id, p.secretId))
    .limit(1);
  // A legacy client-encrypted row cannot be resolved server-side, so a grant
  // on it would promise a read the pod cannot serve.
  if (secret?.encryptionMode !== "server") {
    return { status: "refused", reason: "not_grantable" };
  }
  const agent = await resolveAskingAgent(p);
  if (!agent) return { status: "refused", reason: "agent_unknown" };
  if (
    p.expectedGranteeId !== undefined &&
    p.expectedGranteeId !== agent.agentUserId
  ) {
    return { status: "refused", reason: "agent_changed" };
  }
  return { status: "grant", agent };
}

/**
 * Write the planned read. Returns the outcome for the receipt, and the grant
 * id when THIS call created it (so a refused answer can take it back). Never
 * throws: a failed write is `failed` and the hand-over stands.
 */
export async function grantProvidedSecret(p: {
  plan: SecretGrantPlan;
  secretId: string;
  ownerId: string;
  sessionId: string;
  expectedLabel: string;
}): Promise<{ grant: ProvideSecretGrant; createdGrantId: string | null }> {
  if (p.plan.status === "refused") {
    return {
      grant: { status: "refused", reason: p.plan.reason },
      createdGrantId: null,
    };
  }
  const { agent } = p.plan;
  // Asked BEFORE the try below (which keeps the hand-over when the grant
  // fails): a stale Synap app session must re-confirm it is the person, and
  // the answer must not land without its read (utils/device-session.ts).
  assertFreshAuthentication();
  try {
    assertGrantScoped({ grantedTo: agent.agentUserId, workspaceId: null });
    const written = await applyVaultSecretGrant({
      secretId: p.secretId,
      grantedTo: agent.agentUserId,
      workspaceId: null,
      scope: "session",
      ttlMinutes: PROVIDE_SECRET_GRANT_MINUTES,
      createdBy: p.ownerId,
      reusePermanentOnly: true,
    });
    if (!written.reused) {
      // A read the session's close could not take back is never left behind.
      await bindGrantToSession(p.sessionId, written.grantId).catch(
        async (err: unknown) => {
          await revokeVaultSecretGrant(written.grantId);
          throw err;
        }
      );
      void auditLog({
        subjectType: "vault_secret",
        action: "grant_ai_access",
        phase: "completed",
        subjectId: p.secretId,
        userId: p.ownerId,
        data: {
          grantId: written.grantId,
          grantedTo: agent.agentUserId,
          scope: written.scope,
          expiresAt: written.expiresAt,
          sessionId: p.sessionId,
          expectedLabel: p.expectedLabel,
          via: "provide_answer",
        },
      });
    }
    return {
      grant: {
        status: "granted",
        agentUserId: agent.agentUserId,
        agentName: agent.agentName,
        expiresAt: written.expiresAt,
      },
      createdGrantId: written.reused ? null : written.grantId,
    };
  } catch (err) {
    logger.error(
      { err, sessionId: p.sessionId },
      "the read for the asking agent was not written — the hand-over stands"
    );
    return { grant: { status: "failed" }, createdGrantId: null };
  }
}

/** Take back a read this answer created, when the answer itself was refused. */
export async function withdrawProvidedSecretGrant(
  grantId: string | null
): Promise<void> {
  if (!grantId) return;
  try {
    await revokeVaultSecretGrant(grantId);
  } catch (err) {
    logger.error(
      { err, grantId },
      "the answer was refused but its read could not be taken back"
    );
  }
}

/**
 * Keep the grant on the session it was given for, so its close revokes it.
 * Only an open session: a closed one has no "this session" left to read in,
 * and nothing would take the read back (throws, and the caller revokes).
 */
async function bindGrantToSession(
  sessionId: string,
  grantId: string
): Promise<void> {
  const bound = await db
    .update(focusSessions)
    .set({
      metadata: drizzleSql`jsonb_set(
        COALESCE(${focusSessions.metadata}, '{}'::jsonb),
        ARRAY[${PROVIDE_GRANTS_META_KEY}]::text[],
        COALESCE(${focusSessions.metadata} -> ${PROVIDE_GRANTS_META_KEY}, '[]'::jsonb)
          || ${JSON.stringify([grantId])}::jsonb
      )`,
    })
    .where(
      and(
        eq(focusSessions.id, sessionId),
        notInArray(focusSessions.status, [...TERMINAL_SESSION_STATUSES])
      )
    )
    .returning({ id: focusSessions.id });
  if (bound.length === 0) {
    throw new Error(`session ${sessionId} is closed — no session read`);
  }
}

/**
 * The session ended: take back every read a provide answer granted in it
 * ("in this session" is a promise, not only a TTL). Returns how many were
 * still live. Never throws: a failure is logged and the close stands; the TTL
 * still ends the read.
 */
export async function revokeSessionProvidedGrants(
  sessionId: string
): Promise<number> {
  try {
    const [row] = await db
      .select({
        grantIds: drizzleSql<unknown>`${focusSessions.metadata} -> ${PROVIDE_GRANTS_META_KEY}`,
      })
      .from(focusSessions)
      .where(eq(focusSessions.id, sessionId))
      .limit(1);
    const ids = Array.isArray(row?.grantIds)
      ? row.grantIds.filter((id): id is string => typeof id === "string")
      : [];
    if (ids.length === 0) return 0;
    const revoked = await db
      .update(vaultGrants)
      .set({ revokedAt: new Date() })
      .where(and(inArray(vaultGrants.id, ids), isNull(vaultGrants.revokedAt)))
      .returning({ id: vaultGrants.id });
    return revoked.length;
  } catch (err) {
    logger.error(
      { err, sessionId },
      "the session closed but the reads granted in it could not be revoked — they end with their TTL"
    );
    return 0;
  }
}

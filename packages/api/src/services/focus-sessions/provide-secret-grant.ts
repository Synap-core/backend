/**
 * A SECRET handed over for an ask is one act of consent, not two: the person
 * who answers also lets the agent that ASKED read it, for this session only
 * (`scope: 'session'`, {@link PROVIDE_SECRET_GRANT_MINUTES} minutes). Without
 * this the agent holds a `vault://` reference it cannot read and must file
 * `vault.request`, which the person approves a second time.
 *
 * WHO ASKED is read from the durable record of the ask as posed
 * (`focus_session.slot_asked.completed`, `slot-asked-event.ts`): the newest row
 * for this slot whose fingerprint is the ask being answered, written by the
 * door that posed it with the authenticated agent. Nothing a client sends
 * names the grantee. No such row, a row with no agent (a person posed it, or
 * the decision reactor did), or a row naming something that is not an agent
 * user: the agent is UNKNOWN and no read is granted. The hand-over itself
 * still stands: a reference gives nobody the value, and the agent can still ask
 * through the vault's request door.
 *
 * The grant goes through the ONE grant writer (`applyVaultSecretGrant`),
 * bound to the agent (`grantedTo`) and to no workspace: the agent redeems it
 * wherever it works, and nobody else can.
 */

import { db, and, eq, desc, users, assertGrantScoped } from "@synap/database";
import { events, secrets } from "@synap/database/schema";
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
} from "./lifecycle-events.js";

const logger = createLogger({ module: "provide-secret-grant" });

/** How far back the asker read looks: one slot is asked a handful of times. */
const SLOT_ASKED_SCAN = 50;

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
    const wanted = normalizeExpectedLabel(p.expectedLabel);
    const rows = await db
      .select({ data: events.data })
      .from(events)
      .where(
        and(
          eq(events.subjectType, FOCUS_SESSION_SUBJECT_TYPE),
          eq(events.subjectId, p.sessionId),
          eq(events.type, FOCUS_SESSION_SLOT_ASKED_EVENT_TYPE)
        )
      )
      .orderBy(desc(events.timestamp))
      .limit(SLOT_ASKED_SCAN);
    const posed = rows
      .map((r) => r.data as Record<string, unknown>)
      .find(
        (d) =>
          normalizeExpectedLabel(d.expectedLabel as string | undefined) ===
            wanted && d.askFingerprint === p.askFingerprint
      );
    const agentUserId =
      typeof posed?.askedByAgentUserId === "string"
        ? posed.askedByAgentUserId
        : null;
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
  try {
    assertGrantScoped({ grantedTo: agent.agentUserId, workspaceId: null });
    const written = await applyVaultSecretGrant({
      secretId: p.secretId,
      grantedTo: agent.agentUserId,
      workspaceId: null,
      scope: "session",
      ttlMinutes: PROVIDE_SECRET_GRANT_MINUTES,
      createdBy: p.ownerId,
    });
    if (!written.reused) {
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

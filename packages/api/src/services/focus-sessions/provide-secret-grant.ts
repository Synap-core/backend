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
 * ({@link revokeSessionProvidedGrants}), or ends with its TTL first. The ask
 * asks for `session` reads (the default) or `once` (one read, a 15-minute
 * window); the person may pick the other on the answer. When the agent
 * ALREADY holds a permanent grant on the secret, nothing new is written and
 * the receipt says so (`uses: 'standing'`): that grant is the person's own,
 * never revoked by this session's close.
 *
 * Which grant answered which slot is kept on the session
 * (`metadata.provideSecretGrantBySlot`), so the card can say afterwards how
 * often it was read and offer Take back (`provide-secret-use.ts`). The
 * declared purpose, when the ask has one, is written to `secret_usages`
 * (the vault's "used by"), in this session's context. Both are claims about
 * a hand-over that HAPPENED, so both are written only once the answer
 * committed ({@link recordProvidedSecretAnswer}): an answer refused at the
 * lock leaves neither (review a089b624 S5).
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
import type { SQL } from "@synap/database";
import {
  events,
  secrets,
  secretUsages,
  vaultGrants,
} from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import {
  PROVIDE_SECRET_GRANT_MINUTES,
  type AskSecretPurpose,
  type ProvideSecretGrant,
  type ProvideSecretGrantRefusal,
  type ProvideSecretGrantUses,
  type ProvideSecretUses,
  type ProvideStandingGrant,
} from "@synap-core/types/ask";
import { auditLog } from "../../utils/audit-log.js";
import { grantWriteDenial } from "../../utils/grant-write-check.js";
import {
  applyVaultSecretGrant,
  findActiveSecretGrants,
  revokeVaultSecretGrant,
} from "../vault-secret-grant.js";
import { agentDisplayName } from "../agent-dispatch/binding-call.js";
import { normalizeExpectedLabel } from "./expected-label.js";
import {
  FOCUS_SESSION_SUBJECT_TYPE,
  FOCUS_SESSION_SLOT_ASKED_EVENT_TYPE,
  FOCUS_SESSION_SLOT_ANSWERED_EVENT_TYPE,
} from "./lifecycle-events.js";
import {
  PROVIDE_GRANTS_META_KEY,
  PROVIDE_SECRET_SLOT_GRANTS_META_KEY,
} from "./session-metadata.js";
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
 * What a committed hand-over records about its read ({@link
 * recordProvidedSecretAnswer}): the slot's link to the grant, and the
 * declared purpose as the secret's "used by".
 */
export interface ProvidedSecretRecord {
  sessionId: string;
  expectedLabel: string;
  entry: SlotGrantEntry;
  purpose: AskSecretPurpose | null;
}

/**
 * Write the planned read. Returns the outcome for the receipt, the grant id
 * when THIS call created it (so a refused answer can take it back), and what
 * to record once the answer commits (`record`; null = no read). Never throws:
 * a failed write is `failed` and the hand-over stands.
 */
export async function grantProvidedSecret(p: {
  plan: SecretGrantPlan;
  secretId: string;
  ownerId: string;
  sessionId: string;
  expectedLabel: string;
  /** The reads granted: the person's pick, else the ask's, else `session`. */
  uses?: ProvideSecretUses;
  /** The ask's declared purpose, written as the secret's "used by". */
  purpose?: AskSecretPurpose | null;
}): Promise<{
  grant: ProvideSecretGrant;
  createdGrantId: string | null;
  record: ProvidedSecretRecord | null;
}> {
  if (p.plan.status === "refused") {
    return {
      grant: { status: "refused", reason: p.plan.reason },
      createdGrantId: null,
      record: null,
    };
  }
  const { agent } = p.plan;
  const uses: ProvideSecretUses = p.uses ?? "session";
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
      scope: uses,
      ttlMinutes: uses === "session" ? PROVIDE_SECRET_GRANT_MINUTES : null,
      createdBy: p.ownerId,
      reusePermanentOnly: true,
    });
    // `reusePermanentOnly`: a reused grant is a permanent one the agent
    // already held — the person's, never this session's to take back.
    const grantUses = written.reused ? ("standing" as const) : uses;
    const slotEntry: SlotGrantEntry = {
      grantId: written.grantId,
      secretId: p.secretId,
      agentUserId: agent.agentUserId,
      uses: grantUses,
    };
    if (!written.reused) {
      // A read the session's close could not take back is never left behind.
      // A standing grant stays as it is: the person's, not this session's.
      await bindGrantToSession(p.sessionId, written.grantId).catch(
        async (err: unknown) => {
          await revokeVaultSecretGrant(written.grantId);
          throw err;
        }
      );
    }
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
        ...(written.reused ? { reused: true } : {}),
      },
    });
    return {
      grant: {
        status: "granted",
        agentUserId: agent.agentUserId,
        agentName: agent.agentName,
        expiresAt: written.expiresAt,
        grantId: written.grantId,
        uses: grantUses,
      },
      createdGrantId: written.reused ? null : written.grantId,
      record: {
        sessionId: p.sessionId,
        expectedLabel: p.expectedLabel,
        entry: slotEntry,
        purpose: p.purpose ?? null,
      },
    };
  } catch (err) {
    logger.error(
      { err, sessionId: p.sessionId },
      "the read for the asking agent was not written — the hand-over stands"
    );
    return { grant: { status: "failed" }, createdGrantId: null, record: null };
  }
}

/**
 * The answer COMMITTED: name the grant as the slot's (the card's use line and
 * Take back) and write the declared purpose as the secret's "used by". Never
 * throws: both are presentational, and a committed answer stands.
 */
export async function recordProvidedSecretAnswer(
  record: ProvidedSecretRecord | null
): Promise<void> {
  if (!record) return;
  await recordSlotGrant(
    record.sessionId,
    record.expectedLabel,
    record.entry
  ).catch((err: unknown) =>
    logger.warn(
      { err, sessionId: record.sessionId },
      "the slot's link to its grant was not written — the hand-over stands"
    )
  );
  if (record.purpose) {
    await recordDeclaredUse({
      secretId: record.entry.secretId,
      sessionId: record.sessionId,
      purpose: record.purpose,
    });
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

/** Which grant answered one slot (`metadata.provideSecretGrantBySlot[label]`). */
export interface SlotGrantEntry {
  grantId: string;
  secretId: string;
  agentUserId: string;
  uses: ProvideSecretGrantUses;
}

/** `metadata` with `provideSecretGrantBySlot[label] = entry`, the rest kept. */
function withSlotGrant(base: SQL, label: string, entry: SlotGrantEntry): SQL {
  return drizzleSql`jsonb_set(
    ${base},
    ARRAY[${PROVIDE_SECRET_SLOT_GRANTS_META_KEY}]::text[],
    COALESCE(${focusSessions.metadata} -> ${PROVIDE_SECRET_SLOT_GRANTS_META_KEY}, '{}'::jsonb)
      || jsonb_build_object(${label}::text, ${JSON.stringify(entry)}::jsonb)
  )`;
}

/**
 * Keep the grant on the session it was given for, so its close revokes it.
 * Only an open session: a closed one has no "this session" left to read in,
 * and nothing would take the read back (throws, and the caller revokes). The
 * slot's link to it is written once the answer commits
 * ({@link recordProvidedSecretAnswer}).
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

/** Name a grant as the slot's grant, never binding it to the close. */
async function recordSlotGrant(
  sessionId: string,
  expectedLabel: string,
  entry: SlotGrantEntry
): Promise<void> {
  await db
    .update(focusSessions)
    .set({
      metadata: withSlotGrant(
        drizzleSql`COALESCE(${focusSessions.metadata}, '{}'::jsonb)`,
        expectedLabel,
        entry
      ),
    })
    .where(eq(focusSessions.id, sessionId));
}

/**
 * The ask's declared purpose as the secret's "used by" row (`secret_usages`,
 * the vault Connections face), in this session's context. The tool is what
 * the AGENT declared, not a registry tool id. Best-effort like the tool
 * binding's own row (`routers/tools.ts`): presentational, never a reason to
 * fail the hand-over.
 */
async function recordDeclaredUse(p: {
  secretId: string;
  sessionId: string;
  purpose: AskSecretPurpose;
}): Promise<void> {
  const label = [p.purpose.tool, p.purpose.action]
    .filter((part): part is string => !!part)
    .join(" · ");
  try {
    await db
      .insert(secretUsages)
      .values({
        secretId: p.secretId,
        consumerType: "tool",
        consumerId: p.purpose.tool,
        consumerLabel: label,
        contextType: "focus_session",
        contextId: p.sessionId,
      })
      .onConflictDoUpdate({
        target: [
          secretUsages.secretId,
          secretUsages.consumerType,
          secretUsages.consumerId,
          secretUsages.contextId,
        ],
        set: { consumerLabel: label },
      });
  } catch (err) {
    logger.warn(
      { err, sessionId: p.sessionId },
      "the secret's declared use was not recorded — the hand-over stands"
    );
  }
}

/**
 * The PERMANENT grants the agent already holds on these secrets, by secret
 * id: handing one of them over reuses it (`applyVaultSecretGrant`
 * `reusePermanentOnly`), so the sheet must say so before the person presses.
 * The same read the reuse makes (`findActiveSecretGrants`, the oldest
 * active one), so the sheet names the grant the answer reuses and Take back
 * revokes.
 */
export async function standingGrantsFor(
  agentUserId: string,
  secretIds: readonly string[]
): Promise<Map<string, ProvideStandingGrant>> {
  const active = await findActiveSecretGrants(secretIds, agentUserId, null, {
    scope: "permanent",
  });
  return new Map(
    [...active].map(([secretId, g]) => [
      secretId,
      { grantId: g.grantId, useCount: g.useCount },
    ])
  );
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

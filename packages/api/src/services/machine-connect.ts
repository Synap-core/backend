/**
 * Machine connect — the device door (MACHINE-IDENTITY-PLAN W2 §4), the ONLY
 * way the CLI connects a computer, on self-hosted and managed pods alike.
 *
 *   1. CREATE  (terminal, unauthenticated, IP rate class `device_auth`):
 *      `POST /api/hub/setup/device` → RFC 8628 §3.2 fields.
 *   2. REVIEW  (signed-in person, pod-admin `/device`): `apiKeys.getDeviceRequest`
 *      reads it by the user code; `apiKeys.decideDeviceRequest` approves or
 *      denies — the computer AND the agents in ONE decision.
 *   3. COLLECT (terminal, by device code): `POST /api/hub/setup/device/token`
 *      answers RFC 8628 §3.5 errors until approval, then ONCE mints and returns
 *      the computer's key and its agents' keys.
 *
 * NOTHING SECRET IS STORED IN CLEAR (the `mcp_connect_codes` rule): both codes
 * are sha256 hashes, and no key exists before collection. Collection CLAIMS the
 * row (approved → consumed) before minting, so one approval can never mint
 * twice; a failed mint burns the request (the person re-runs `synap init`).
 *
 * The computer is an agent user of type `machine` (origin `device`, created by
 * the approver); its key is a `user_pat` linked to the approver, so it reads
 * what the approver may read and writes as itself, governed. Each agent is
 * "<type> on <computer>" (`users.host_user_id`). Posture FIRST, then keys
 * (the `ensureAppAgent` precedent): a new computer or agent starts ask-first.
 * Reach: the "AI — read & propose" preset; an agent's grant is clipped to the
 * computer's (`clipHostedAgentGrants`, inside `attachGrantsOrRevoke`).
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { TRPCError } from "@trpc/server";
import {
  and,
  db,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  sql,
  drizzleSql,
  ApiKeyRepository,
  EventRepository,
} from "@synap/database";
import {
  apiKeys,
  deviceAuthRequests,
  podSettings,
  users,
  type AgentMetadata,
  type DeviceAuthRequest,
} from "@synap/database/schema";
import { revokeApiKeys } from "@synap/database/api-key-revocation";
import {
  applyAgentPosture,
  readAgentGovernance,
} from "@synap/database/agent-governance";
import {
  AI_READ_PROPOSE_ROLE_ID,
  GRANT_PRESETS,
  aiDefaultCapabilities,
} from "@synap-core/types/grants";
import { MACHINE_AGENT_TYPE, agentDisplayName } from "@synap-core/types/agents";
import { resolveServiceName } from "@synap-core/types/service-marks";
import { auditLog } from "../utils/audit-log.js";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { attachGrantOrRevoke } from "./key-grant.js";
import {
  insertServiceAgentUser,
  provisionSurfaceAgentKey,
} from "./agent-identity-service.js";
import { createAndVerifyHubInboundKey } from "./external-registration.js";
import {
  AGENT_KEY_ROTATION_LEAD_DAYS,
  AGENT_KEY_TTL_DAYS,
  SETUP_AGENT_HUB_SCOPES,
} from "./hub-integration-registration.js";

// ── Contract constants ──────────────────────────────────────────────────────

/** RFC 8628 `expires_in`: a request lives 10 minutes. */
export const DEVICE_REQUEST_TTL_SECONDS = 600;
/** RFC 8628 `interval`: the slowest a terminal may poll, at first. */
export const DEVICE_POLL_INTERVAL_SECONDS = 5;
/** RFC 8628 §3.5 `slow_down`: the interval grows by this much each time. */
export const DEVICE_SLOW_DOWN_STEP_SECONDS = 5;
/** Wrong codes a request (and a person, per window) may take before it locks. */
export const DEVICE_MAX_WRONG_CODES = 5;
/** Agents one request may ask for. */
export const DEVICE_MAX_AGENTS = 8;

/**
 * The token endpoint's RFC 8628 §3.5 error vocabulary (+ `invalid_grant`, the
 * OAuth answer to a device code the pod does not know). The `satisfies` floor
 * makes every member a declared RFC/OAuth name — a typo or an invented error
 * fails the build.
 */
const RFC8628_ERRORS = [
  "authorization_pending",
  "slow_down",
  "access_denied",
  "expired_token",
  "invalid_grant",
] as const satisfies ReadonlyArray<
  | "authorization_pending"
  | "slow_down"
  | "access_denied"
  | "expired_token"
  | "invalid_grant"
  | "invalid_request"
>;
export type DeviceTokenError = (typeof RFC8628_ERRORS)[number];
export const DEVICE_TOKEN_ERRORS: readonly DeviceTokenError[] = RFC8628_ERRORS;

// ── Codes ───────────────────────────────────────────────────────────────────

/** 8 chars, no 0/O/1/I/L — read off a terminal without ambiguity (§6.1). */
const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function sha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** "abcd efgh", "ABCD-EFGH" and "abcdefgh" are the same code. */
export function normalizeUserCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function hashUserCode(raw: string): string {
  return sha256(normalizeUserCode(raw));
}

function generateUserCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += USER_CODE_ALPHABET[bytes[i]! % USER_CODE_ALPHABET.length];
    if (i === 3) out += "-";
  }
  return out;
}

function sameHash(a: string, b: string): boolean {
  return (
    a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}

// ── 1. Create ───────────────────────────────────────────────────────────────

export interface CreateDeviceRequestInput {
  clientName: string;
  hostname: string;
  platform?: string | null;
  /** Agent types to run on this computer (validated by the route). */
  agents: readonly string[];
  requesterIp?: string | null;
  userAgent?: string | null;
  /** pod-admin origin, for `verification_uri`. */
  podAdminOrigin: string;
}

export interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export async function createDeviceRequest(
  input: CreateDeviceRequestInput
): Promise<DeviceAuthorizationResponse> {
  // Housekeeping: requests past their TTL hold nothing anyone can use.
  await db
    .delete(deviceAuthRequests)
    .where(lt(deviceAuthRequests.expiresAt, new Date()));

  const deviceCode = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + DEVICE_REQUEST_TTL_SECONDS * 1000);
  // A user code is unique among PENDING requests (partial unique index); a
  // collision is ~1/31^8 — retry a few times rather than ever reuse one.
  for (let attempt = 0; attempt < 5; attempt++) {
    const userCode = generateUserCode();
    try {
      await db.insert(deviceAuthRequests).values({
        deviceCodeHash: sha256(deviceCode),
        userCodeHash: hashUserCode(userCode),
        clientName: input.clientName,
        hostname: input.hostname,
        platform: input.platform ?? null,
        requestedAgents: [...new Set(input.agents)],
        requesterIp: input.requesterIp ?? null,
        userAgent: input.userAgent ?? null,
        pollIntervalSeconds: DEVICE_POLL_INTERVAL_SECONDS,
        expiresAt,
      });
      const verificationUri = `${input.podAdminOrigin}/device`;
      void auditLog({
        subjectType: "apiKey",
        action: "create",
        phase: "requested",
        subjectId: sha256(deviceCode).slice(0, 16),
        userId: "anonymous",
        workspaceId: null,
        data: {
          kind: "device_request",
          hostname: input.hostname,
          clientName: input.clientName,
          agents: input.agents,
          requesterIp: input.requesterIp ?? null,
        },
      });
      return {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: verificationUri,
        verification_uri_complete: `${verificationUri}?code=${encodeURIComponent(userCode)}`,
        expires_in: DEVICE_REQUEST_TTL_SECONDS,
        interval: DEVICE_POLL_INTERVAL_SECONDS,
      };
    } catch (err) {
      if (attempt === 4) throw err;
    }
  }
  throw new Error("unreachable");
}

// ── 2. Review (signed-in person) ────────────────────────────────────────────

/**
 * Per-person wrong-code window: a lookup by a code that matches no waiting
 * request cannot be pinned on any request, so it counts against the PERSON
 * (RFC 8628 §5.1 — bound user-code guessing). In-process, like the hub
 * limiter; a pod runs one API process.
 */
const missesByPerson = new Map<string, { count: number; resetAt: number }>();
const MISS_WINDOW_MS = DEVICE_REQUEST_TTL_SECONDS * 1000;

function assertNotLockedOut(personId: string): void {
  const entry = missesByPerson.get(personId);
  if (
    entry &&
    entry.resetAt > Date.now() &&
    entry.count >= DEVICE_MAX_WRONG_CODES
  )
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Too many wrong codes. Wait a few minutes, then try again.",
    });
}

function recordMiss(personId: string): void {
  const now = Date.now();
  const entry = missesByPerson.get(personId);
  if (!entry || entry.resetAt <= now)
    missesByPerson.set(personId, { count: 1, resetAt: now + MISS_WINDOW_MS });
  else entry.count++;
}

/** Test seam: forget every per-person window. */
export function resetDeviceCodeMissesForTests(): void {
  missesByPerson.clear();
}

export interface DeviceRequestView {
  requestId: string;
  status: "pending" | "approved" | "denied" | "consumed" | "expired";
  clientName: string;
  hostname: string;
  platform: string | null;
  /** Each agent the terminal asked for, with the name it will carry. */
  agents: Array<{ agentType: string; name: string; displayName: string }>;
  requesterIp: string | null;
  userAgent: string | null;
  createdAt: Date;
  expiresAt: Date;
  /** The person's own computers with this hostname: reuse keeps agents, history, rules. */
  reusableComputers: Array<{ id: string; name: string; createdAt: Date }>;
  /** Days the keys will last (computer override → pod default → 90). */
  keyTtlDays: number;
  /** The reach the computer gets — the preset's name, shown in Details. */
  accessName: string;
}

function viewStatus(row: DeviceAuthRequest): DeviceRequestView["status"] {
  if (row.status === "pending" && row.expiresAt.getTime() <= Date.now())
    return "expired";
  return row.status;
}

const AI_PRESET_NAME =
  GRANT_PRESETS.find((p) => p.id === AI_READ_PROPOSE_ROLE_ID)?.name ??
  "AI — read & propose";

/** "claude-code" → "Claude Code" (the ONE service-name door). */
export function agentTypeName(agentType: string): string {
  return resolveServiceName(agentType);
}

export async function getDeviceRequest(args: {
  userCode: string;
  personId: string;
}): Promise<DeviceRequestView> {
  assertNotLockedOut(args.personId);
  const [row] = await db
    .select()
    .from(deviceAuthRequests)
    .where(eq(deviceAuthRequests.userCodeHash, hashUserCode(args.userCode)))
    .orderBy(drizzleSql`${deviceAuthRequests.createdAt} DESC`)
    .limit(1);
  if (!row) {
    recordMiss(args.personId);
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "No computer is waiting with that code.",
    });
  }
  const reusable = await db
    .select({ id: users.id, name: users.name, createdAt: users.createdAt })
    .from(users)
    .where(
      and(
        eq(users.userType, "agent"),
        eq(users.agentType, MACHINE_AGENT_TYPE),
        eq(users.createdByUserId, args.personId),
        drizzleSql`${users.agentMetadata}->>'hostname' = ${row.hostname}`
      )
    );
  return {
    requestId: row.id,
    status: viewStatus(row),
    clientName: row.clientName,
    hostname: row.hostname,
    platform: row.platform,
    agents: row.requestedAgents.map((agentType) => ({
      agentType,
      name: agentTypeName(agentType),
      displayName: agentDisplayName({
        name: agentTypeName(agentType),
        hostName: row.hostname,
      }),
    })),
    requesterIp: row.requesterIp,
    userAgent: row.userAgent,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    reusableComputers: reusable.map((r) => ({
      id: r.id,
      name: r.name ?? row.hostname,
      createdAt: r.createdAt,
    })),
    keyTtlDays: await resolveMachineKeyTtlDays(null),
    accessName: AI_PRESET_NAME,
  };
}

export interface DecideDeviceRequestInput {
  requestId: string;
  /** The code the person checked against the terminal — bound to the request. */
  userCode: string;
  personId: string;
  decision: "approve" | "deny";
  /** Approve: the agents kept (a subset of those asked). Omitted = all. */
  agents?: readonly string[];
  /** Approve: one of `reusableComputers`, or omitted for a new computer. */
  reuseComputerId?: string | null;
  /** Approve: the computer's display name (default: its hostname). */
  computerName?: string | null;
}

export async function decideDeviceRequest(
  input: DecideDeviceRequestInput
): Promise<{ status: "approved" | "denied" }> {
  const [row] = await db
    .select()
    .from(deviceAuthRequests)
    .where(eq(deviceAuthRequests.id, input.requestId))
    .limit(1);
  if (!row)
    throw new TRPCError({ code: "NOT_FOUND", message: "Request not found." });
  if (row.status !== "pending")
    throw new TRPCError({
      code: "CONFLICT",
      message: "This request was already decided.",
    });
  if (row.expiresAt.getTime() <= Date.now())
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This request expired. Run the command again in your terminal.",
    });

  // The code is the device binding: it must be the one this terminal shows.
  // Each wrong one counts against THIS request; the fifth denies it.
  if (!sameHash(hashUserCode(input.userCode), row.userCodeHash)) {
    const [after] = await db
      .update(deviceAuthRequests)
      .set({
        failedCodeAttempts: drizzleSql`${deviceAuthRequests.failedCodeAttempts} + 1`,
        status: drizzleSql`CASE WHEN ${deviceAuthRequests.failedCodeAttempts} + 1 >= ${DEVICE_MAX_WRONG_CODES} THEN 'denied' ELSE ${deviceAuthRequests.status} END`,
      })
      .where(
        and(
          eq(deviceAuthRequests.id, row.id),
          eq(deviceAuthRequests.status, "pending")
        )
      )
      .returning({ status: deviceAuthRequests.status });
    void auditLog({
      subjectType: "apiKey",
      action: "create",
      phase: "failed",
      subjectId: row.id,
      userId: input.personId,
      workspaceId: null,
      data: { kind: "device_request", reason: "wrong_code" },
    });
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        after?.status === "denied"
          ? "Too many wrong codes — this request is closed. Run the command again in your terminal."
          : "That code doesn't match the one in your terminal.",
    });
  }

  if (input.decision === "deny") {
    await db
      .update(deviceAuthRequests)
      .set({ status: "denied", approvedByUserId: input.personId })
      .where(
        and(
          eq(deviceAuthRequests.id, row.id),
          eq(deviceAuthRequests.status, "pending")
        )
      );
    void auditLog({
      subjectType: "apiKey",
      action: "create",
      phase: "rejected",
      subjectId: row.id,
      userId: input.personId,
      workspaceId: null,
      data: { kind: "device_request", hostname: row.hostname },
    });
    return { status: "denied" };
  }

  const agents = input.agents
    ? [...new Set(input.agents)]
    : row.requestedAgents;
  const outside = agents.filter((a) => !row.requestedAgents.includes(a));
  if (outside.length > 0)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Not asked for by this computer: ${outside.join(", ")}`,
    });

  if (input.reuseComputerId) {
    const [machine] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, input.reuseComputerId),
          eq(users.userType, "agent"),
          eq(users.agentType, MACHINE_AGENT_TYPE),
          eq(users.createdByUserId, input.personId)
        )
      )
      .limit(1);
    if (!machine)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "That computer is not one of yours.",
      });
  }

  // Governance is consulted: a person deciding in their own session IS the
  // decision, but policy may still refuse a key being made.
  const perm = await checkPermissionOrPropose({
    userId: input.personId,
    subjectType: "apiKey",
    action: "create",
    data: {
      kind: "device",
      hostname: row.hostname,
      agents,
      reuseComputerId: input.reuseComputerId ?? null,
    },
  });
  if ("denied" in perm && perm.denied)
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  if (!("granted" in perm && perm.granted))
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Connecting a computer needs your own approval, signed in.",
    });

  const [updated] = await db
    .update(deviceAuthRequests)
    .set({
      status: "approved",
      approvedByUserId: input.personId,
      approvedAt: new Date(),
      approvedAgents: agents,
      machineUserId: input.reuseComputerId ?? null,
      machineName: input.computerName?.trim() || null,
    })
    .where(
      and(
        eq(deviceAuthRequests.id, row.id),
        eq(deviceAuthRequests.status, "pending")
      )
    )
    .returning({ id: deviceAuthRequests.id });
  if (!updated)
    throw new TRPCError({
      code: "CONFLICT",
      message: "This request was already decided.",
    });
  void auditLog({
    subjectType: "apiKey",
    action: "create",
    phase: "approved",
    subjectId: row.id,
    userId: input.personId,
    workspaceId: null,
    data: {
      kind: "device_request",
      hostname: row.hostname,
      agents,
      reuseComputerId: input.reuseComputerId ?? null,
      requesterIp: row.requesterIp,
    },
  });
  return { status: "approved" };
}

// ── 3. Collect (terminal) ───────────────────────────────────────────────────

export interface CollectedKey {
  apiKey: string;
  keyId: string;
  expiresAt: string | null;
}

export interface DeviceTokenSuccess {
  /** RFC 8628 §3.5 / RFC 6749 §5.1: the computer's key. */
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  computer: CollectedKey & { id: string; name: string };
  agents: Array<
    CollectedKey & {
      agentType: string;
      agentUserId: string;
      name: string;
      displayName: string;
    }
  >;
}

export type DeviceTokenResult =
  | { ok: true; body: DeviceTokenSuccess }
  | { ok: false; error: DeviceTokenError; interval?: number };

export async function collectDeviceToken(args: {
  deviceCode: string;
}): Promise<DeviceTokenResult> {
  const hash = sha256(args.deviceCode);
  const [row] = await db
    .select()
    .from(deviceAuthRequests)
    .where(eq(deviceAuthRequests.deviceCodeHash, hash))
    .limit(1);
  if (!row) return { ok: false, error: "invalid_grant" };
  if (row.status === "consumed" || row.expiresAt.getTime() <= Date.now())
    return { ok: false, error: "expired_token" };

  // §3.5 slow_down: a poll inside the interval widens it by 5 s.
  const now = new Date();
  if (
    row.lastPolledAt &&
    now.getTime() - row.lastPolledAt.getTime() < row.pollIntervalSeconds * 1000
  ) {
    const interval = row.pollIntervalSeconds + DEVICE_SLOW_DOWN_STEP_SECONDS;
    await db
      .update(deviceAuthRequests)
      .set({ lastPolledAt: now, pollIntervalSeconds: interval })
      .where(eq(deviceAuthRequests.id, row.id));
    return { ok: false, error: "slow_down", interval };
  }
  await db
    .update(deviceAuthRequests)
    .set({ lastPolledAt: now })
    .where(eq(deviceAuthRequests.id, row.id));

  if (row.status === "denied") return { ok: false, error: "access_denied" };
  if (row.status !== "approved")
    return { ok: false, error: "authorization_pending" };

  // CLAIM before mint: exactly one poll moves approved → consumed.
  const [claimed] = await db
    .update(deviceAuthRequests)
    .set({ status: "consumed", consumedAt: now })
    .where(
      and(
        eq(deviceAuthRequests.id, row.id),
        eq(deviceAuthRequests.status, "approved"),
        gt(deviceAuthRequests.expiresAt, now)
      )
    )
    .returning();
  if (!claimed) return { ok: false, error: "expired_token" };

  const body = await mintForApprovedRequest(claimed);
  await db
    .update(deviceAuthRequests)
    .set({ machineUserId: body.computer.id, mintedKeyId: body.computer.keyId })
    .where(eq(deviceAuthRequests.id, claimed.id));
  void auditLog({
    subjectType: "apiKey",
    action: "create",
    phase: "completed",
    subjectId: claimed.id,
    userId: claimed.approvedByUserId!,
    agentUserId: body.computer.id,
    workspaceId: null,
    data: {
      kind: "device_request",
      hostname: claimed.hostname,
      computerKeyId: body.computer.keyId,
      agentKeyIds: body.agents.map((a) => a.keyId),
    },
  });
  return { ok: true, body };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Key lifetime for a computer and the agents it hosts: the computer's own
 * `agentMetadata.keyTtlDays` → the pod default
 * (`pod_settings.settings.machineDefaults.keyTtlDays`) → 90.
 */
export async function resolveMachineKeyTtlDays(
  machineUserId: string | null
): Promise<number> {
  const valid = (n: unknown): n is number =>
    typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 3650;
  if (machineUserId) {
    const [m] = await db
      .select({ meta: users.agentMetadata })
      .from(users)
      .where(eq(users.id, machineUserId))
      .limit(1);
    const own = (m?.meta as AgentMetadata | null)?.keyTtlDays;
    if (valid(own)) return own;
  }
  const [pod] = await db
    .select({ settings: podSettings.settings })
    .from(podSettings)
    .orderBy(podSettings.createdAt)
    .limit(1);
  const podDefault = pod?.settings?.machineDefaults?.keyTtlDays;
  return valid(podDefault) ? podDefault : AGENT_KEY_TTL_DAYS;
}

/**
 * The pod default's bounds. Floor: longer than the rotation lead, or a key
 * would be "due for rotation" the day it is minted. Ceiling: the resolver's
 * own `valid` ceiling, so a stored default is never silently ignored.
 */
export const MACHINE_KEY_TTL_MIN_DAYS = AGENT_KEY_ROTATION_LEAD_DAYS + 1;
export const MACHINE_KEY_TTL_MAX_DAYS = 3650;

/**
 * Pod-admin settings: the pod default computer key lifetime (founder decision
 * 4). `keyTtlDays` is what a new computer gets (stored default, else 90);
 * `stored` says whether a pod admin set it.
 */
export async function readMachineDefaults(): Promise<{
  keyTtlDays: number;
  stored: boolean;
  defaultKeyTtlDays: number;
  minKeyTtlDays: number;
  maxKeyTtlDays: number;
}> {
  const [pod] = await db
    .select({ settings: podSettings.settings })
    .from(podSettings)
    .orderBy(podSettings.createdAt)
    .limit(1);
  const stored = pod?.settings?.machineDefaults?.keyTtlDays;
  return {
    keyTtlDays: await resolveMachineKeyTtlDays(null),
    stored: typeof stored === "number",
    defaultKeyTtlDays: AGENT_KEY_TTL_DAYS,
    minKeyTtlDays: MACHINE_KEY_TTL_MIN_DAYS,
    maxKeyTtlDays: MACHINE_KEY_TTL_MAX_DAYS,
  };
}

/**
 * Set the pod default computer key lifetime. Merges into the singleton
 * `pod_settings.settings` blob (the `proactive.setPodDefaults` pattern) and
 * applies to keys minted from now on; existing keys keep their expiry.
 */
export async function setMachineKeyTtlDays(keyTtlDays: number): Promise<void> {
  if (
    !Number.isInteger(keyTtlDays) ||
    keyTtlDays < MACHINE_KEY_TTL_MIN_DAYS ||
    keyTtlDays > MACHINE_KEY_TTL_MAX_DAYS
  )
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `A computer key lasts between ${MACHINE_KEY_TTL_MIN_DAYS} and ${MACHINE_KEY_TTL_MAX_DAYS} days.`,
    });
  const machineDefaults = { keyTtlDays };
  const [existing] = await db
    .select({ id: podSettings.id })
    .from(podSettings)
    .orderBy(podSettings.createdAt)
    .limit(1);
  if (existing) {
    await db
      .update(podSettings)
      .set({
        settings: drizzleSql`coalesce(${podSettings.settings}, '{}'::jsonb) || ${JSON.stringify(
          { machineDefaults }
        )}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(podSettings.id, existing.id));
  } else {
    await db.insert(podSettings).values({ settings: { machineDefaults } });
  }
}

/** A NEW principal starts ask-first; one the person already set keeps theirs. */
async function postureFirst(agentUserId: string, by: string): Promise<void> {
  const state = await readAgentGovernance({ db, agentUserId });
  if (state && !state.configured)
    await applyAgentPosture({
      db,
      agentUserId,
      posture: "ask-first",
      createdBy: by,
    });
}

/**
 * The computer principal: the one the approver chose to reuse (its agents,
 * history and rules kept), else a new `machine` agent user. Posture is applied
 * BEFORE anything links to it (no key yet exists).
 */
export async function ensureMachineAgent(args: {
  approverId: string;
  reuseId: string | null;
  name: string;
  hostname: string;
  platform: string | null;
}): Promise<string> {
  let machineId = args.reuseId;
  if (machineId) {
    await db
      .update(users)
      .set({
        agentMetadata: drizzleSql`coalesce(${users.agentMetadata}, '{}'::jsonb) || ${JSON.stringify(
          { hostname: args.hostname, platform: args.platform ?? undefined }
        )}::jsonb`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(users.id, machineId),
          eq(users.agentType, MACHINE_AGENT_TYPE),
          eq(users.createdByUserId, args.approverId)
        )
      );
  } else {
    ({ agentUserId: machineId } = await insertServiceAgentUser({
      creatorId: args.approverId,
      agentType: MACHINE_AGENT_TYPE,
      label: args.name,
      createdVia: "device",
      metadata: {
        description: `Computer ${args.hostname}`,
        capabilities: aiDefaultCapabilities(),
        hostname: args.hostname,
        ...(args.platform ? { platform: args.platform } : {}),
      },
    }));
  }
  await postureFirst(machineId, args.approverId);
  return machineId;
}

async function mintForApprovedRequest(
  row: DeviceAuthRequest
): Promise<DeviceTokenSuccess> {
  const approverId = row.approvedByUserId!;
  const name = row.machineName?.trim() || row.hostname;
  const machineId = await ensureMachineAgent({
    approverId,
    reuseId: row.machineUserId,
    name,
    hostname: row.hostname,
    platform: row.platform,
  });
  const [machine] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, machineId))
    .limit(1);
  const computerName = machine?.name ?? name;
  const ttlDays = await resolveMachineKeyTtlDays(machineId);

  // One live key per computer: a re-enrolment replaces the old one.
  await revokeApiKeys(db, {
    where: and(eq(apiKeys.userId, machineId), isNull(apiKeys.revokedAt)),
    revokedBy: approverId,
    reason: "Computer re-connected — replaced by a new key",
  });
  const nowMs = Date.now();
  const registration = await createAndVerifyHubInboundKey(
    new ApiKeyRepository(db, new EventRepository(sql)),
    {
      keyName: `${computerName} (computer)`,
      scope: [...SETUP_AGENT_HUB_SCOPES],
      userId: machineId,
      keyType: "user_pat",
      description: `Computer key for ${computerName} — connected via the device flow`,
      linkedUserId: approverId,
      expiresAt: new Date(nowMs + ttlDays * DAY_MS),
      rotationScheduledAt: new Date(
        nowMs + Math.max(ttlDays - AGENT_KEY_ROTATION_LEAD_DAYS, 1) * DAY_MS
      ),
    },
    approverId,
    machineId
  );
  if (registration.outcome !== "CONNECTED_VERIFIED")
    throw new Error(
      `Computer key failed verification: ${registration.verificationError ?? registration.outcome}`
    );
  await attachGrantOrRevoke({
    apiKeyId: registration.apiKey.id,
    principalUserId: machineId,
    onBehalfOf: approverId,
    grant: { permissions: aiDefaultCapabilities(), label: AI_PRESET_NAME },
    expiresAt: registration.apiKey.expiresAt ?? null,
    createdBy: approverId,
  });

  const agents: DeviceTokenSuccess["agents"] = [];
  for (const agentType of row.approvedAgents ?? []) {
    const label = agentTypeName(agentType);
    const provisioned = await provisionSurfaceAgentKey({
      agentType,
      createdByUserId: approverId,
      linkedUserId: approverId,
      hostUserId: machineId,
      createdVia: "device",
      agentLabel: label,
      ensureRegistryRow: true,
      ttlDays,
      agentDescription: `${agentDisplayName({ name: label, hostName: computerName })} — connected via the device flow`,
      keyName: `${agentDisplayName({ name: label, hostName: computerName })} Hub Key`,
      keyDescription: `Hub Protocol key for ${agentDisplayName({ name: label, hostName: computerName })}`,
      // Posture FIRST — before this agent's key exists.
      onAgentUserResolved: (agentUserId) =>
        postureFirst(agentUserId, approverId),
    });
    if (provisioned.alreadyValid)
      throw new Error("Agent key provisioning returned no fresh key");
    if (provisioned.registration.outcome !== "CONNECTED_VERIFIED")
      throw new Error(`Agent key for ${agentType} failed verification`);
    agents.push({
      agentType,
      agentUserId: provisioned.agentUserId,
      name: label,
      displayName: agentDisplayName({ name: label, hostName: computerName }),
      apiKey: provisioned.plainKey,
      keyId: provisioned.keyId,
      expiresAt: provisioned.apiKey.expiresAt?.toISOString() ?? null,
    });
  }

  return {
    access_token: registration.plainKey,
    token_type: "Bearer",
    expires_in: ttlDays * 24 * 60 * 60,
    computer: {
      id: machineId,
      name: computerName,
      apiKey: registration.plainKey,
      keyId: registration.apiKey.id,
      expiresAt: registration.apiKey.expiresAt?.toISOString() ?? null,
    },
    agents,
  };
}

// ── Revoke a computer ───────────────────────────────────────────────────────

/**
 * Revoke a computer: its keys AND the keys of every agent it hosts, through
 * the one revoke door. The agents stay listed with their history.
 */
export async function revokeMachine(args: {
  machineUserId: string;
  by: string;
  reason?: string;
}): Promise<number> {
  const hosted = (
    await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.hostUserId, args.machineUserId))
  ).map((r) => r.id);
  const rows = await revokeApiKeys(db, {
    where: and(
      inArray(apiKeys.userId, [args.machineUserId, ...hosted]),
      isNull(apiKeys.revokedAt)
    ),
    revokedBy: args.by,
    reason: args.reason ?? "Computer revoked",
  });
  return rows.length;
}

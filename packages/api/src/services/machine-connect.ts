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
 * (the `ensureAppAgent` precedent): a new computer starts ask-first; its agents
 * take the write mode the approver chose (`AGENT_WRITE_MODE_CHOICES`, normal
 * recommended), or ask-first when the approving surface sent none.
 * Reach: the "AI — read & propose" preset; an agent's grant is clipped to the
 * computer's (`clipHostedAgentGrants`, inside `attachGrantsOrRevoke`).
 *
 * AGENTS INSIDE A COMPUTER (0395, plan "Computer once, agents inside" D1-D9):
 * a computer is approved once; each agent inside it is one per (person,
 * computer, SEAT = the OS user, ENGINE = agentType, ROLE = its job). A newer
 * CLI names its seat (`seat`, `seatId`), the keys it holds (`held`) and the
 * job of each agent (`rows`); an older one names none of them. The person's
 * decision is per row: add an agent, reconnect ONE agent, or skip — defaulted
 * by evidence (`recommendRowAction`, @synap-core/types/device), never by the
 * hostname. Collection re-keys only what was decided: this seat's computer
 * key, and the agents the person ticked. Nothing else on the computer changes.
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
  or,
  sql,
  drizzleSql,
  notAnAppAgent,
  readReversibleDefault,
  ApiKeyRepository,
  EventRepository,
} from "@synap/database";
import {
  BOX_RUNNER_SCOPE,
  HOST_RUNNER_SCOPE,
  apiKeys,
  deviceAuthRequests,
  installationBindings,
  installations,
  podSettings,
  users,
  type AgentMetadata,
  type DeviceAuthRequest,
} from "@synap/database/schema";
import { revokeApiKeys } from "@synap/database/api-key-revocation";
import {
  applyAgentPosture,
  readAgentGovernance,
  revokeAllHostSeedsOn,
} from "@synap/database/agent-governance";
import {
  AI_READ_PROPOSE_ROLE_ID,
  GRANT_PRESETS,
  aiDefaultCapabilities,
} from "@synap-core/types/grants";
import {
  MACHINE_AGENT_TYPE,
  UNNAMED_SEAT_PREFIX,
  agentDisplayName,
  agentInComputerName,
  agentPostureOfWriteMode,
  agentRoleLabel,
  isUnclaimedSeat,
  resolveAgentWriteMode,
  type AgentWriteMode,
} from "@synap-core/types/agents";
import {
  DEVICE_IN_USE_WINDOW_MS,
  DEVICE_MAX_AGENTS,
  recommendRowAction,
  rowKey,
  type DeviceAgentAction,
  type DeviceAgentActionKind,
  type DeviceHeldKey,
  type DeviceRecommendationReason,
  type DeviceRequestedRow,
  type DeviceStoredAgentAction,
  type EvidenceAgent,
} from "@synap-core/types/device";
import type { ComputerBelongsTo } from "@synap-core/types/computers";
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

/**
 * The revoke reason when a computer re-enrols and its new key replaces the
 * old one. Read back by the holder's key-state (`isReplacementReason`).
 */
export const MACHINE_RECONNECTED_REPLACED =
  "Computer re-connected — replaced by a new key";

export const DEVICE_REQUEST_TTL_SECONDS = 600;
/** RFC 8628 `interval`: the slowest a terminal may poll, at first. */
export const DEVICE_POLL_INTERVAL_SECONDS = 5;
/** RFC 8628 §3.5 `slow_down`: the interval grows by this much each time. */
export const DEVICE_SLOW_DOWN_STEP_SECONDS = 5;
/** Wrong codes a request (and a person, per window) may take before it locks. */
export const DEVICE_MAX_WRONG_CODES = 5;
/** Agents one request may ask for (one constant, @synap-core/types/device). */
export { DEVICE_MAX_AGENTS };

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
  /**
   * 0395, all optional (an older CLI sends none): the OS user asking, its
   * stable id (this seat's computer-key instance), the agents with their job,
   * and the key ids this seat holds locally (evidence, never a secret).
   */
  seat?: string | null;
  seatId?: string | null;
  rows?: readonly DeviceRequestedRow[];
  held?: readonly DeviceHeldKey[];
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
  const rows = normalizeRows(input.rows, input.agents);
  const engines = [...new Set(rows.map((r) => r.agentType))];
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
        requestedAgents: engines,
        seat: input.seat ?? null,
        seatId: input.seatId ?? null,
        held: input.held?.length ? [...input.held] : null,
        requestedRows: input.rows?.length ? rows : null,
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
          agents: engines,
          rows,
          seat: input.seat ?? null,
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

/**
 * The rows a request asks for: the CLI's `rows` (engine + job), deduped by
 * (engine, job), else one plain row per engine of `agents` (an older CLI).
 */
function normalizeRows(
  rows: readonly DeviceRequestedRow[] | null | undefined,
  agents: readonly string[]
): Array<{ agentType: string; role: string | null; roleLabel: string | null }> {
  const source: readonly DeviceRequestedRow[] = rows?.length
    ? rows
    : agents.map((agentType) => ({ agentType }));
  const seen = new Set<string>();
  const out: Array<{
    agentType: string;
    role: string | null;
    roleLabel: string | null;
  }> = [];
  for (const r of source) {
    const role = r.role ?? null;
    const key = rowKey(r.agentType, role);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      agentType: r.agentType,
      role,
      roleLabel: role ? agentRoleLabel(role, r.roleLabel) : null,
    });
  }
  return out;
}

/** A stored request's rows (0395), else one per requested engine. */
function rowsOf(row: DeviceAuthRequest) {
  return normalizeRows(row.requestedRows, row.requestedAgents);
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
  reusableComputers: Array<{
    id: string;
    name: string;
    createdAt: Date;
    /** Whose computer it is today (0388); the approval may change it. */
    belongsTo: ComputerBelongsTo | null;
    /**
     * The agents it hosts (`users.host_user_id`), each with the newest
     * `last_used_at` over its keys, its seat, job, whether a runner served it
     * and whether a key of it works now: what the person checks before
     * choosing, per row, to add an agent or reconnect one.
     */
    agents: Array<{
      id: string;
      name: string;
      lastSeenAt: Date | null;
      agentType: string | null;
      seat: string | null;
      role: string | null;
      workerServedAt: Date | null;
      live: boolean;
      writeMode: AgentWriteMode | null;
    }>;
    /** Per row, what approving does on this computer by default (evidence). */
    recommended: Array<{
      rowKey: string;
      action: "add" | "reconnect";
      agentId: string | null;
      reason: DeviceRecommendationReason;
    }>;
  }>;
  /** Days the keys will last (computer override → pod default → 90). */
  keyTtlDays: number;
  /** The reach the computer gets — the preset's name, shown in Details. */
  accessName: string;
  /** The OS user asking (0395); null from an older CLI. */
  seat: string | null;
  /** The agents asked for, each an engine with an optional job (0395). */
  rows: Array<{
    key: string;
    agentType: string;
    role: string | null;
    roleLabel: string | null;
    name: string;
  }>;
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
    .select({
      id: users.id,
      name: users.name,
      createdAt: users.createdAt,
      belongsTo: users.computerBelongsTo,
    })
    .from(users)
    .where(
      and(
        eq(users.userType, "agent"),
        eq(users.agentType, MACHINE_AGENT_TYPE),
        eq(users.createdByUserId, args.personId),
        drizzleSql`${users.agentMetadata}->>'hostname' = ${row.hostname}`
      )
    );
  const hosted = await hostedAgentsOf(reusable.map((r) => r.id));
  const rows = rowsOf(row);
  const now = Date.now();
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
      belongsTo: r.belongsTo ?? null,
      agents: hosted
        .filter((a) => a.hostUserId === r.id)
        .map((a) => ({
          id: a.id,
          name:
            a.name?.trim() || (a.agentType ? agentTypeName(a.agentType) : ""),
          lastSeenAt: a.lastSeenAt,
          agentType: a.agentType,
          seat: a.seat,
          role: a.role,
          workerServedAt: a.workerServedAt,
          live: a.live,
          writeMode: a.writeMode,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      recommended: rows.map((rw) => ({
        rowKey: rowKey(rw.agentType, rw.role),
        ...recommendRowAction({
          row: rw,
          seat: row.seat,
          heldKeyIds: (row.held ?? []).map((k) => k.keyId),
          agents: hosted.filter((a) => a.hostUserId === r.id),
          now,
        }),
      })),
    })),
    keyTtlDays: await resolveMachineKeyTtlDays(null),
    accessName: AI_PRESET_NAME,
    seat: row.seat,
    rows: rows.map((rw) => ({
      key: rowKey(rw.agentType, rw.role),
      agentType: rw.agentType,
      role: rw.role,
      roleLabel: rw.roleLabel,
      name: agentTypeName(rw.agentType),
    })),
  };
}

/**
 * The agents these computers host, with what the device page and the
 * evidence rule read: seat, job, newest key, newest use over its LIVE keys,
 * whether a runner served it, and how its changes land today. Oldest first,
 * so a rule that picks "the first match" picks the stable one.
 */
async function hostedAgentsOf(machineIds: readonly string[]): Promise<
  Array<
    EvidenceAgent & {
      name: string | null;
      hostUserId: string;
      lastSeenAt: Date | null;
      workerServedAt: Date | null;
      live: boolean;
      writeMode: AgentWriteMode | null;
    }
  >
> {
  if (machineIds.length === 0) return [];
  const hosted = await db
    .select({
      id: users.id,
      name: users.name,
      agentType: users.agentType,
      hostUserId: users.hostUserId,
      seat: users.hostSeat,
      role: users.agentRole,
    })
    .from(users)
    .where(
      and(
        inArray(users.hostUserId, [...machineIds]),
        eq(users.userType, "agent"),
        notAnAppAgent(users.id)
      )
    )
    .orderBy(users.createdAt);
  if (hosted.length === 0) return [];
  const keys = await db
    .select({
      id: apiKeys.id,
      userId: apiKeys.userId,
      lastUsedAt: apiKeys.lastUsedAt,
      workerServedAt: apiKeys.workerServedAt,
      isActive: apiKeys.isActive,
      revokedAt: apiKeys.revokedAt,
      expiresAt: apiKeys.expiresAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(
      inArray(
        apiKeys.userId,
        hosted.map((a) => a.id)
      )
    );
  const now = Date.now();
  const isLive = (k: (typeof keys)[number]) =>
    k.isActive && !k.revokedAt && (!k.expiresAt || k.expiresAt.getTime() > now);
  const maxDate = (ds: Array<Date | null>): Date | null =>
    ds.reduce<Date | null>((m, d) => (d && (!m || d > m) ? d : m), null);
  const podDefault = (await readReversibleDefault(db)).enabled;
  const out = [];
  for (const a of hosted) {
    const own = keys.filter((k) => k.userId === a.id);
    const live = own.filter(isLive);
    const newest = [...own].sort(
      (x, y) => y.createdAt.getTime() - x.createdAt.getTime()
    )[0];
    const state = await readAgentGovernance({ db, agentUserId: a.id });
    out.push({
      id: a.id,
      name: a.name,
      agentType: a.agentType ?? "",
      hostUserId: a.hostUserId!,
      seat: a.seat,
      role: a.role,
      newestKeyId: newest?.id ?? null,
      liveKeyLastUsedAt: maxDate(live.map((k) => k.lastUsedAt)),
      lastSeenAt: maxDate(own.map((k) => k.lastUsedAt)),
      workerServedAt: maxDate(own.map((k) => k.workerServedAt)),
      live: live.length > 0,
      writeMode: state
        ? resolveAgentWriteMode({
            posture: state.posture,
            podDefaultEnabled: podDefault,
            writesRequireProposal: state.writesRequireProposal,
          })
        : null,
    });
  }
  return out;
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
  /**
   * Approve: whose computer it is (0388). Omitted: a new computer is the
   * person's own; a reused one keeps what it was.
   */
  belongsTo?: ComputerBelongsTo | null;
  /**
   * Approve: how the ADDED agents' writes land (0394), one of
   * `AGENT_WRITE_MODE_CHOICES`; a NEW computer takes it too (D1b, the
   * ceiling of its agents). Omitted: a new agent and a new computer start
   * ask-first. A reconnected agent keeps its own (D6, amends 0394) unless its
   * row says; a reused computer keeps its own.
   */
  agentWriteMode?: AgentWriteMode | null;
  /**
   * Approve, per row (0395): add an agent, reconnect ONE agent of the reused
   * computer, or skip. Omitted (an older surface): each kept engine takes the
   * pod's recommendation by evidence — never a hostname reconnect.
   */
  agentActions?: readonly DeviceAgentAction[] | null;
}

/**
 * The decision per row, checked and stored until the terminal collects:
 * the person's `agentActions`, else every kept row at its recommendation.
 * A reconnect must name an agent this computer hosts for this person, of the
 * row's engine; nothing else may be re-keyed.
 */
async function resolveAgentActions(args: {
  row: DeviceAuthRequest;
  personId: string;
  reuseComputerId: string | null;
  keptEngines: readonly string[];
  actions: readonly DeviceAgentAction[] | null | undefined;
}): Promise<DeviceStoredAgentAction[]> {
  const { row } = args;
  const hosted = args.reuseComputerId
    ? await hostedAgentsOf([args.reuseComputerId])
    : [];
  if (!args.actions) {
    const heldKeyIds = (row.held ?? []).map((k) => k.keyId);
    const now = Date.now();
    return rowsOf(row)
      .filter((r) => args.keptEngines.includes(r.agentType))
      .map((r) => {
        const rec = args.reuseComputerId
          ? recommendRowAction({
              row: r,
              seat: row.seat,
              heldKeyIds,
              agents: hosted,
              now,
            })
          : { action: "add" as const, agentId: null };
        return {
          agentType: r.agentType,
          role: r.role,
          roleLabel: r.roleLabel,
          action: rec.action,
          agentId: rec.action === "reconnect" ? rec.agentId : null,
          writeMode: null,
        };
      });
  }
  if (args.actions.length > DEVICE_MAX_AGENTS)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `At most ${DEVICE_MAX_AGENTS} agents per request.`,
    });
  const out: DeviceStoredAgentAction[] = [];
  const addKeys = new Set<string>();
  const reconnected = new Set<string>();
  for (const a of args.actions) {
    if (!row.requestedAgents.includes(a.agentType))
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Not asked for by this computer: ${a.agentType}`,
      });
    if (a.action === "skip") continue;
    if (a.action === "reconnect") {
      const target = hosted.find((h) => h.id === a.agentId);
      if (!target || target.agentType !== a.agentType)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "That agent is not one this computer runs for you. Choose it again.",
        });
      if (reconnected.has(target.id)) continue;
      reconnected.add(target.id);
      out.push({
        agentType: a.agentType,
        role: target.role,
        roleLabel: null,
        action: "reconnect",
        agentId: target.id,
        writeMode: a.writeMode ?? null,
      });
      continue;
    }
    const role = a.role ?? null;
    const key = rowKey(a.agentType, role);
    if (addKeys.has(key))
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "The same agent is added twice. Give each a different job.",
      });
    addKeys.add(key);
    out.push({
      agentType: a.agentType,
      role,
      roleLabel: role ? agentRoleLabel(role, a.roleLabel) : null,
      action: "add",
      agentId: null,
      writeMode: a.writeMode ?? null,
    });
  }
  return out;
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

  const agents = input.agentActions
    ? [
        ...new Set(
          input.agentActions
            .filter((a) => a.action !== "skip")
            .map((a) => a.agentType)
        ),
      ]
    : input.agents
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

  const agentActions = await resolveAgentActions({
    row,
    personId: input.personId,
    reuseComputerId: input.reuseComputerId ?? null,
    keptEngines: agents,
    actions: input.agentActions,
  });

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
      agentActions,
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
      approvedAgents: [...new Set(agentActions.map((a) => a.agentType))],
      agentActions,
      machineUserId: input.reuseComputerId ?? null,
      machineName: input.computerName?.trim() || null,
      computerBelongsTo: input.belongsTo ?? null,
      agentWriteMode: input.agentWriteMode ?? null,
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
      agentActions,
      seat: row.seat,
      reuseComputerId: input.reuseComputerId ?? null,
      belongsTo: input.belongsTo ?? null,
      agentWriteMode: input.agentWriteMode ?? null,
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
      /** 0395: its job (null = the engine's plain agent) and its seat. */
      role: string | null;
      seat: string | null;
      /** 0395: what collection did to it. */
      action: "added" | "reconnected";
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

/**
 * An approved agent's posture, before its key exists: the write mode the
 * approver chose, applied as is (`agentPostureOfWriteMode`: normal = no
 * override, the pod default acts); none chosen = {@link postureFirst}.
 */
async function agentPostureAtConnect(
  agentUserId: string,
  by: string,
  mode: AgentWriteMode | null
): Promise<void> {
  if (!mode) return postureFirst(agentUserId, by);
  await applyAgentPosture({
    db,
    agentUserId,
    posture: agentPostureOfWriteMode(mode),
    createdBy: by,
  });
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
 * BEFORE anything links to it (no key yet exists). Whose computer it is
 * (0388): what the approver chose, else `person` for a new one; a reused one
 * keeps its own unless the approver chose (`setMachineBelongsTo`, the one
 * writer, which also takes back an agent's seeds when it stops being theirs).
 *
 * What agents on it may do (plan 07ecf0be D1b): a NEW computer takes the one
 * mode the approver picked for its first agents (`writeMode`; none picked =
 * ask-first, as before). A computer is the ceiling of every agent on it, so a
 * computer left ask-first would make that pick say nothing. A REUSED computer
 * keeps what the person set on its page, like a reconnected agent (D6): a
 * reconnect never resets it.
 */
export async function ensureMachineAgent(args: {
  approverId: string;
  reuseId: string | null;
  name: string;
  hostname: string;
  platform: string | null;
  belongsTo?: ComputerBelongsTo | null;
  writeMode?: AgentWriteMode | null;
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
  const belongsTo = args.belongsTo ?? (args.reuseId ? null : "person");
  if (belongsTo) await setMachineBelongsTo(machineId, belongsTo);
  if (!args.reuseId)
    await agentPostureAtConnect(
      machineId,
      args.approverId,
      args.writeMode ?? null
    );
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
    belongsTo: row.computerBelongsTo,
    writeMode: row.agentWriteMode,
  });
  const [machine] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, machineId))
    .limit(1);
  const computerName = machine?.name ?? name;
  const ttlDays = await resolveMachineKeyTtlDays(machineId);
  // "Runs scripts" survives a reconnect: the new key carries `box.runner`
  // when the person turned it on for this computer (machines.setRunsScripts).
  const [machineMeta] = await db
    .select({ meta: users.agentMetadata })
    .from(users)
    .where(eq(users.id, machineId))
    .limit(1);
  const runsScripts =
    (machineMeta?.meta as AgentMetadata | null)?.runsScripts === true;
  // "Installs from the pod" survives a reconnect the same way (host.runner,
  // machines.setHostsServices).
  const hostsServices =
    (machineMeta?.meta as AgentMetadata | null)?.hostsServices === true;

  // One live computer key per SEAT (0395, D4): a re-enrolment replaces only
  // this seat's own — its instance (`seat_id`), or a pre-seat key this seat
  // says it holds. Another OS user's computer key is never touched. An older
  // CLI names no seat: it replaces only a pre-seat key nobody used in 24 h.
  await revokeApiKeys(db, {
    where: and(
      eq(apiKeys.userId, machineId),
      isNull(apiKeys.revokedAt),
      thisSeatsComputerKeys(row)
    ),
    revokedBy: approverId,
    reason: MACHINE_RECONNECTED_REPLACED,
  });
  const nowMs = Date.now();
  const registration = await createAndVerifyHubInboundKey(
    new ApiKeyRepository(db, new EventRepository(sql)),
    {
      keyName: `${computerName} (computer)`,
      scope: [
        ...SETUP_AGENT_HUB_SCOPES,
        ...(runsScripts ? [BOX_RUNNER_SCOPE] : []),
        ...(hostsServices ? [HOST_RUNNER_SCOPE] : []),
      ],
      userId: machineId,
      keyType: "user_pat",
      description: `Computer key for ${computerName} — connected via the device flow`,
      linkedUserId: approverId,
      // The seat's key: its instance is the seat id, and its label the OS
      // user, which `/setup/agent` reads to file an agent on this seat.
      instanceId: row.seatId ?? null,
      instanceLabel: row.seat ?? null,
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
  const showSeat = await computerHasManySeats(machineId, row.seat);
  for (const action of storedActionsOf(row)) {
    if (action.action === "skip") continue;
    const target =
      action.action === "reconnect"
        ? await reconnectTarget({
            machineId,
            approverId,
            action,
            seat: row.seat,
          })
        : {
            seat: await seatForAdd({
              machineId,
              approverId,
              row,
              agentType: action.agentType,
              role: action.role,
            }),
            role: action.role,
            agentId: null,
          };
    const engine = agentTypeName(action.agentType);
    const label = action.role
      ? agentRoleLabel(action.role, action.roleLabel)
      : engine;
    const shown = agentInComputerName({
      agentType: action.agentType,
      role: target.role,
      roleLabel: action.roleLabel,
      hostName: computerName,
      seat: target.seat,
      showSeat,
    });
    const provisioned = await provisionSurfaceAgentKey({
      agentType: action.agentType,
      createdByUserId: approverId,
      linkedUserId: approverId,
      hostUserId: machineId,
      hostSeat: target.seat,
      agentRole: target.role,
      createdVia: "device",
      agentLabel: label,
      ensureRegistryRow: true,
      ttlDays,
      agentDescription: `${shown} — connected via the device flow`,
      keyName: `${shown} Hub Key`,
      keyDescription: `Hub Protocol key for ${shown}`,
      // Posture FIRST — before this agent's key exists. An added agent takes
      // the person's choice; a reconnected one keeps its own unless the
      // person changed it (D6).
      onAgentUserResolved: async (agentUserId) => {
        if (target.agentId && agentUserId !== target.agentId)
          throw new Error("Reconnect resolved a different agent");
        if (action.action === "add")
          return agentPostureAtConnect(
            agentUserId,
            approverId,
            action.writeMode ?? row.agentWriteMode
          );
        if (action.writeMode)
          return agentPostureAtConnect(
            agentUserId,
            approverId,
            action.writeMode
          );
      },
    });
    if (provisioned.alreadyValid)
      throw new Error("Agent key provisioning returned no fresh key");
    if (provisioned.registration.outcome !== "CONNECTED_VERIFIED")
      throw new Error(`Agent key for ${action.agentType} failed verification`);
    agents.push({
      agentType: action.agentType,
      agentUserId: provisioned.agentUserId,
      name: label,
      displayName: shown,
      role: target.role,
      seat: target.seat,
      action: action.action === "add" ? "added" : "reconnected",
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

/**
 * The computer keys a request replaces: this seat's (its `seat_id` instance,
 * or a pre-seat key it holds); for an older CLI (no seat), only a pre-seat
 * key that nobody used in the last 24 h.
 */
function thisSeatsComputerKeys(row: DeviceAuthRequest) {
  const heldIds = (row.held ?? []).map((k) => k.keyId);
  if (row.seatId)
    return heldIds.length
      ? or(
          eq(apiKeys.instanceId, row.seatId),
          and(isNull(apiKeys.instanceId), inArray(apiKeys.id, heldIds))
        )
      : eq(apiKeys.instanceId, row.seatId);
  return and(
    isNull(apiKeys.instanceId),
    or(
      isNull(apiKeys.lastUsedAt),
      lt(apiKeys.lastUsedAt, new Date(Date.now() - DEVICE_IN_USE_WINDOW_MS))
    )
  );
}

/**
 * A request's decision per row: the stored one (0395), else — a request
 * approved before 0395 and collected after — one plain "add" per approved
 * engine, which resolves the same agent as before (seat-less, role-less).
 */
function storedActionsOf(row: DeviceAuthRequest): DeviceStoredAgentAction[] {
  if (row.agentActions) return row.agentActions;
  return (row.approvedAgents ?? []).map((agentType) => ({
    agentType,
    role: null,
    roleLabel: null,
    action: "add" as DeviceAgentActionKind,
    agentId: null,
    writeMode: null,
  }));
}

/** More than one OS user on this computer: agent names carry the seat. */
async function computerHasManySeats(
  machineId: string,
  seat: string | null
): Promise<boolean> {
  const rows = await db
    .select({ seat: users.hostSeat })
    .from(users)
    .where(eq(users.hostUserId, machineId));
  const seats = new Set(rows.map((r) => r.seat).filter((x) => x != null));
  if (seat) seats.add(seat);
  return seats.size > 1;
}

/**
 * The seat a NEW agent takes: the asking OS user's. An older CLI names none:
 * the agent is the seat-less one when that is free, else an `unnamed:` seat
 * of its own — never the seat-less agent another process is using.
 */
async function seatForAdd(args: {
  machineId: string;
  approverId: string;
  row: DeviceAuthRequest;
  agentType: string;
  role: string | null;
}): Promise<string | null> {
  if (args.row.seat) return args.row.seat;
  const [taken] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.userType, "agent"),
        eq(users.hostUserId, args.machineId),
        eq(users.createdByUserId, args.approverId),
        eq(users.agentType, args.agentType),
        isNull(users.hostSeat),
        args.role ? eq(users.agentRole, args.role) : isNull(users.agentRole)
      )
    )
    .limit(1);
  return taken ? `${UNNAMED_SEAT_PREFIX}${args.row.id.slice(0, 8)}` : null;
}

/**
 * The ONE agent a reconnect re-keys: hosted by this computer, the person's,
 * of the row's engine. A seat-less (or unnamed) agent is claimed by the
 * asking seat (0395 §8: the person chose it, on evidence), unless that seat
 * already has its own agent for this job.
 */
async function reconnectTarget(args: {
  machineId: string;
  approverId: string;
  action: DeviceStoredAgentAction;
  seat: string | null;
}): Promise<{ seat: string | null; role: string | null; agentId: string }> {
  const [agent] = await db
    .select({ id: users.id, seat: users.hostSeat, role: users.agentRole })
    .from(users)
    .where(
      and(
        eq(users.id, args.action.agentId ?? ""),
        eq(users.userType, "agent"),
        eq(users.hostUserId, args.machineId),
        eq(users.createdByUserId, args.approverId),
        eq(users.agentType, args.action.agentType)
      )
    )
    .limit(1);
  if (!agent) throw new Error("The agent to reconnect is no longer here");
  let seat = agent.seat;
  if (args.seat && isUnclaimedSeat(agent.seat)) {
    try {
      const [claimed] = await db
        .update(users)
        .set({ hostSeat: args.seat, updatedAt: new Date() })
        .where(eq(users.id, agent.id))
        .returning({ seat: users.hostSeat });
      seat = claimed?.seat ?? seat;
    } catch {
      // The seat already has this job's agent: keep this one as it was.
    }
  }
  return { seat, role: agent.role, agentId: agent.id };
}

// ── Whose computer it is ────────────────────────────────────────────────────

/**
 * THE writer of `users.computer_belongs_to` (0388): the device approval and
 * `machines.setBelongsTo` both come here. A computer that stops belonging to
 * an agent loses every approval seeded on it for its agents
 * (`revokeAllHostSeedsOn`, host-seed.ts): a person's own or a shared computer
 * keeps its agents as guests. Returns the seeds taken back.
 */
export async function setMachineBelongsTo(
  machineId: string,
  belongsTo: ComputerBelongsTo
): Promise<{ seedsRevoked: number }> {
  return db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ computerBelongsTo: belongsTo, updatedAt: new Date() })
      .where(
        and(eq(users.id, machineId), eq(users.agentType, MACHINE_AGENT_TYPE))
      );
    const seedsRevoked =
      belongsTo === "agent" ? 0 : await revokeAllHostSeedsOn(tx, machineId);
    return { seedsRevoked };
  });
}

// ── Revoke a computer ───────────────────────────────────────────────────────

/**
 * Revoke a computer: its keys, the keys of every agent it hosts, AND the keys
 * of every installation on it and of each of their bindings (0409, addendum
 * 000e75ff §7: "removing the computer revokes them all"), through the one
 * revoke door. The agents and installations stay listed with their history.
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
  const installed = await installationPrincipalsOn(args.machineUserId);
  const rows = await revokeApiKeys(db, {
    where: and(
      or(
        inArray(apiKeys.userId, [
          args.machineUserId,
          ...hosted,
          ...installed.userIds,
        ]),
        ...(installed.keyIds.length > 0
          ? [inArray(apiKeys.id, installed.keyIds)]
          : [])
      ),
      isNull(apiKeys.revokedAt)
    ),
    revokedBy: args.by,
    reason: args.reason ?? "Computer revoked",
  });
  return rows.length;
}

/**
 * The principals of every installation on a computer and of their bindings:
 * each one's own agent user and its own key (U6 mints them). Removed
 * installations are included: a key that outlived its removal is revoked too.
 */
async function installationPrincipalsOn(
  machineUserId: string
): Promise<{ userIds: string[]; keyIds: string[] }> {
  const rows = await db
    .select({
      instAgent: installations.agentUserId,
      instKey: installations.apiKeyId,
      bindAgent: installationBindings.agentUserId,
      bindKey: installationBindings.apiKeyId,
    })
    .from(installations)
    .leftJoin(
      installationBindings,
      eq(installationBindings.installationId, installations.id)
    )
    .where(eq(installations.machineUserId, machineUserId));
  const userIds = new Set<string>();
  const keyIds = new Set<string>();
  for (const r of rows) {
    if (r.instAgent) userIds.add(r.instAgent);
    if (r.bindAgent) userIds.add(r.bindAgent);
    if (r.instKey) keyIds.add(r.instKey);
    if (r.bindKey) keyIds.add(r.bindKey);
  }
  return { userIds: [...userIds], keyIds: [...keyIds] };
}

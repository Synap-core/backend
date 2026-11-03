/**
 * The device flow's ONE rule (MACHINE-IDENTITY-PLAN W3 + W6): a computer
 * asking to connect, approved by a person who types — or scans — the code the
 * terminal shows. Two surfaces ask this question and must never disagree:
 * pod-admin `/device` (the web) and Relay's "Connect a computer" (the phone).
 * Both import this file; neither re-derives a state, a default or a payload.
 *
 * What lives here: the code grammar, which state a read lands in (including
 * how a refused read is classified), the "reconnect or new" default, the exact
 * decision each button sends, and whether approving is a HOLD (the connect
 * card's rule, read through the one holder reader). What does NOT: markup,
 * transport, and how a surface signs in.
 *
 * Words for domain values come from the vocabulary door — the noun
 * ("Computer"), agent names ("Claude Code on devbox") and statuses. Pure:
 * loaded by Next (pod-admin), React Native (relay) and Node alike.
 */
import {
  MACHINE_AGENT_TYPE,
  agentDisplayName,
  agentInComputerName,
  isUnclaimedSeat,
  seatLine,
  type AgentWriteMode,
} from "../agents/index.js";
import { GRANT_PRESETS, resolveHolderAccess } from "../grants/index.js";
import { resolveObjectNoun, resolveStatusLabel } from "../vocabulary/index.js";

/** `apiKeys.getDeviceRequest` as it arrives over JSON (dates are ISO strings). */
export interface DeviceRequest {
  requestId: string;
  status: "pending" | "approved" | "denied" | "consumed" | "expired";
  clientName: string;
  hostname: string;
  platform: string | null;
  agents: Array<{ agentType: string; name: string; displayName: string }>;
  requesterIp: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
  reusableComputers: Array<{
    id: string;
    name: string;
    createdAt: string;
    /**
     * The agents it hosts, kept by a reconnect (their keys are replaced).
     * Absent from a pod older than this read: the line then names none.
     */
    agents?: DeviceHostedAgent[];
    /**
     * Per row, what approving does on THIS computer by default, decided by
     * evidence (`recommendRowAction`, run by the pod). Absent from a pod
     * older than 0395.
     */
    recommended?: DeviceRowRecommendation[];
  }>;
  keyTtlDays: number;
  accessName: string;
  /** The OS user asking (0395). Null/absent: an older CLI, which names none. */
  seat?: string | null;
  /**
   * The agents asked for, each an engine with an optional job (0395). Absent
   * from a pod older than 0395: read `agents`.
   */
  rows?: DeviceRow[];
}

/** One agent a terminal asks for: an engine, with an optional job. */
export interface DeviceRow {
  /** `rowKey(agentType, role)`: what a decision and a recommendation name. */
  key: string;
  agentType: string;
  role: string | null;
  roleLabel: string | null;
  /** The engine's name ("Claude Code"). */
  name: string;
}

/** An agent a computer already hosts, as the device page shows it. */
export interface DeviceHostedAgent {
  id: string;
  name: string;
  lastSeenAt: string | null;
  /** The fields below are absent from a pod older than 0395. */
  agentType?: string | null;
  seat?: string | null;
  role?: string | null;
  /** When a runner (`synap worker`) last called with one of its keys. */
  workerServedAt?: string | null;
  /** It holds a key that works now. */
  live?: boolean;
  /** How its changes land today (kept by a reconnect unless changed, D6). */
  writeMode?: AgentWriteMode | null;
}

export type DeviceAgentActionKind = "add" | "reconnect" | "skip";

/** Why a row defaults to what it does, in evidence terms. */
export type DeviceRecommendationReason =
  /** This OS user's own agent (same seat, engine and job). */
  | "this-seat"
  /** An agent made before seats whose newest key this OS user holds. */
  | "held"
  /** An agent made before seats whose key has not been used for 24 h. */
  | "idle"
  /** An agent made before seats, in use elsewhere: never re-keyed by default. */
  | "in-use"
  /** Only agents of other OS users match: they stay as they are. */
  | "other-seat"
  /** Nothing on this computer matches. */
  | "new";

export interface DeviceRowRecommendation {
  rowKey: string;
  action: "add" | "reconnect";
  /** The agent a reconnect re-keys (null for add). */
  agentId: string | null;
  reason: DeviceRecommendationReason;
}

/** A key a seat holds locally — its id only, never the secret. */
export interface DeviceHeldKey {
  keyId: string;
  agentUserId?: string | null;
}

/** What the terminal asked for, as stored on the request (0395). */
export interface DeviceRequestedRow {
  agentType: string;
  role?: string | null;
  roleLabel?: string | null;
}

/** The person's decision for one row, as `decideDeviceRequest` takes it. */
export interface DeviceAgentAction {
  agentType: string;
  role?: string | null;
  roleLabel?: string | null;
  action: DeviceAgentActionKind;
  /** reconnect: the agent re-keyed. */
  agentId?: string | null;
  /**
   * How its changes land. add: omitted = the request's `agentWriteMode`,
   * else ask-first. reconnect: omitted = KEEP the agent's current one (D6).
   */
  writeMode?: AgentWriteMode | null;
}

/** A decision row as the pod stores it until the terminal collects. */
export interface DeviceStoredAgentAction {
  agentType: string;
  role: string | null;
  roleLabel: string | null;
  action: DeviceAgentActionKind;
  agentId: string | null;
  writeMode: AgentWriteMode | null;
}

/** "claude-code:" / "claude-code:crm-worker" — one row of a request. */
export function rowKey(agentType: string, role?: string | null): string {
  return `${agentType}:${role ?? ""}`;
}

/** The input `apiKeys.decideDeviceRequest` takes. */
export interface DeviceDecision {
  requestId: string;
  userCode: string;
  decision: "approve" | "deny";
  agents?: string[];
  reuseComputerId?: string | null;
  computerName?: string | null;
  /** How the approved agents' writes land (`AGENT_WRITE_MODE_CHOICES`). */
  agentWriteMode?: AgentWriteMode | null;
  /**
   * Per row: add, reconnect one agent, or skip (0395). Sent only to a pod
   * that served `rows`; without it the pod applies its recommendations.
   */
  agentActions?: DeviceAgentAction[];
}

/** Agents one device request may ask for (the pod's limit, every door). */
export const DEVICE_MAX_AGENTS = 8;

/** "Computer" — the one noun, from the vocabulary door. */
export const COMPUTER_NOUN = resolveObjectNoun(MACHINE_AGENT_TYPE);

/** The command that prints a fresh code — the way out of every dead end. */
export const DEVICE_RUN_AGAIN_COMMAND = "synap init";

// ── Code ─────────────────────────────────────────────────────────────────────

/** The pod's alphabet has no 0/O/1/I/L; we accept any case, with or without a dash. */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** A full code is 8 characters — anything shorter would only cost a wrong-code attempt. */
export function isCompleteCode(raw: string): boolean {
  return normalizeCode(raw).length === 8;
}

/** "abcdefgh" / "ABCD-EFGH" → "ABCD-EFGH" (as the terminal prints it). */
export function formatCode(raw: string): string {
  const c = normalizeCode(raw);
  return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

/**
 * The code a link arrived with (`/device?code=…`, `synap://device?code=…`),
 * or null when there is none worth reading. An incomplete code is null — the
 * person types it instead of spending a wrong-code attempt. A repeated query
 * param (`string[]`, as a router hands it) reads its first value.
 */
export function initialDeviceCode(raw: unknown): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && isCompleteCode(t) ? t : null;
}

// ── Read → state ─────────────────────────────────────────────────────────────

/**
 * The read, as the pod answers it. A miss (404) and a lock-out (429) are
 * ANSWERS — the pod looked and said so; `failed` is the pod never answering.
 * They are different facts and render differently (never a calm empty page
 * for a failed read).
 */
export type DeviceRead =
  | { kind: "loading" }
  | { kind: "ok"; request: DeviceRequest }
  | { kind: "unknown" }
  | { kind: "locked"; message: string }
  | { kind: "failed"; message: string };

export const DEVICE_LOCKED_FALLBACK = "Wait a few minutes, then try again.";

/**
 * A refused read → its state. Either surface hands what it has: an HTTP
 * status (the web proxy) and/or a tRPC code (the phone's client). Signing in
 * again is the surface's own business and is decided before this is called.
 */
export function deviceReadFromError(err: {
  status?: number | null;
  code?: string | null;
  message?: string | null;
}): DeviceRead {
  const message = err.message?.trim() || null;
  if (err.status === 404 || err.code === "NOT_FOUND")
    return { kind: "unknown" };
  if (err.status === 429 || err.code === "TOO_MANY_REQUESTS")
    return { kind: "locked", message: message ?? DEVICE_LOCKED_FALLBACK };
  return {
    kind: "failed",
    message:
      message ??
      (err.status ? `Error (${err.status})` : "Could not reach this pod."),
  };
}

export type DeviceStage =
  | "enter" // no code yet
  | "loading"
  | "pending"
  | "approved" // REASSURE
  | "denied" // confirmation
  | "gone" // expired / consumed / unknown code → EXPLAIN + run again
  | "locked" // too many wrong codes → EXPLAIN + wait
  | "failed"; // the read failed → error + Retry

export function deviceStage(
  code: string | null,
  read: DeviceRead
): DeviceStage {
  if (!code) return "enter";
  switch (read.kind) {
    case "loading":
      return "loading";
    case "unknown":
      return "gone";
    case "locked":
      return "locked";
    case "failed":
      return "failed";
    case "ok":
      switch (read.request.status) {
        case "pending":
          return "pending";
        case "approved":
          return "approved";
        case "denied":
          return "denied";
        case "expired":
        case "consumed":
          return "gone";
      }
  }
}

/** Why a code leads nowhere — the EXPLAIN title (copy, a sentence). */
export function goneTitle(read: DeviceRead): string {
  if (read.kind === "ok")
    return read.request.status === "consumed"
      ? "This code was already used"
      : "This request expired";
  return "No computer is waiting with that code";
}

/** The status mark's word — the vocabulary door, never a local map. */
export function statusLabel(status: DeviceRequest["status"]): string {
  return resolveStatusLabel(status);
}

/** The read after a decision landed: the same request, in its answered status. */
export function decidedRead(
  request: DeviceRequest,
  decision: DeviceDecision["decision"]
): DeviceRead {
  return {
    kind: "ok",
    request: {
      ...request,
      status: decision === "approve" ? "approved" : "denied",
    },
  };
}

// ── Choices ──────────────────────────────────────────────────────────────────

/**
 * Reconnect by default when one of the person's computers carries the same
 * name as the terminal's hostname (locked decision 2); otherwise a new one.
 */
export function defaultReuseId(req: DeviceRequest): string | null {
  const host = req.hostname.trim().toLowerCase();
  return (
    req.reusableComputers.find((c) => c.name.trim().toLowerCase() === host)
      ?.id ?? null
  );
}

// ── Agents inside a computer (0395) ─────────────────────────────────────────

/**
 * How long a key's last use counts as "in use": an agent whose live key was
 * used inside this window is never re-keyed by default from another seat or
 * an older CLI (plan 31470fd5 §8: the 2 Nov incident).
 */
export const DEVICE_IN_USE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** What the pod knows about a hosted agent when it recommends a row. */
export interface EvidenceAgent {
  id: string;
  agentType: string;
  seat: string | null;
  role: string | null;
  /** Its newest key by creation, live or not (what a seat "holds"). */
  newestKeyId: string | null;
  /** Newest last use over its live keys; null = none used, or none live. */
  liveKeyLastUsedAt: string | Date | null;
}

/** A live key of it was used inside {@link DEVICE_IN_USE_WINDOW_MS}. */
export function agentInUse(a: EvidenceAgent, now: number): boolean {
  if (!a.liveKeyLastUsedAt) return false;
  return (
    now - new Date(a.liveKeyLastUsedAt).getTime() < DEVICE_IN_USE_WINDOW_MS
  );
}

/**
 * THE default for one row on a known computer (D5: by evidence, never by
 * hostname). In order:
 *   1. this OS user's own agent (same seat, engine, job) → reconnect it;
 *   2. an agent made before seats (or by an older CLI) whose NEWEST key this
 *      seat holds → reconnect (and claim) it;
 *   3. such an agent whose key has not been used for 24 h → reconnect it;
 *   4. otherwise → add a new agent: an agent in use, or another OS user's,
 *      stays exactly as it is.
 * An older CLI names no seat and holds nothing, so only rule 3 can make it
 * reconnect: it never re-keys an agent used in the last 24 h.
 */
export function recommendRowAction(input: {
  row: { agentType: string; role?: string | null };
  seat: string | null;
  heldKeyIds: readonly string[];
  agents: readonly EvidenceAgent[];
  now: number;
}): Omit<DeviceRowRecommendation, "rowKey"> {
  const role = input.row.role ?? null;
  const same = input.agents.filter(
    (a) => a.agentType === input.row.agentType && (a.role ?? null) === role
  );
  if (input.seat) {
    const own = same.find((a) => a.seat === input.seat);
    if (own)
      return { action: "reconnect", agentId: own.id, reason: "this-seat" };
  }
  const unclaimed = same.filter((a) => isUnclaimedSeat(a.seat));
  const held = new Set(input.heldKeyIds);
  const heldOne = unclaimed.find(
    (a) => a.newestKeyId !== null && held.has(a.newestKeyId)
  );
  if (heldOne)
    return { action: "reconnect", agentId: heldOne.id, reason: "held" };
  const idle = unclaimed.find((a) => !agentInUse(a, input.now));
  if (idle) return { action: "reconnect", agentId: idle.id, reason: "idle" };
  if (unclaimed.length > 0)
    return { action: "add", agentId: null, reason: "in-use" };
  if (same.length > 0)
    return { action: "add", agentId: null, reason: "other-seat" };
  return { action: "add", agentId: null, reason: "new" };
}

/** The rows of a request: `rows` from a 0395 pod, else one per engine. */
export function deviceRows(req: DeviceRequest): DeviceRow[] {
  return (
    req.rows ??
    req.agents.map((a) => ({
      key: rowKey(a.agentType, null),
      agentType: a.agentType,
      role: null,
      roleLabel: null,
      name: a.name,
    }))
  );
}

/** The page's choice for one row. */
export interface DeviceAgentChoice {
  rowKey: string;
  agentType: string;
  role: string | null;
  roleLabel: string | null;
  action: DeviceAgentActionKind;
  agentId: string | null;
  /** Only when the person changed it (a reconnect keeps the current one). */
  writeMode?: AgentWriteMode;
}

/**
 * Every row starts at the pod's recommendation for the computer being
 * reused (by evidence), and at "add" for a new computer. Never a hostname
 * reconnect (`defaultReuseId` only picks the COMPUTER).
 */
export function defaultAgentActions(
  req: DeviceRequest,
  reuseId: string | null
): DeviceAgentChoice[] {
  const computer = reuseId
    ? req.reusableComputers.find((c) => c.id === reuseId)
    : undefined;
  return deviceRows(req).map((row) => {
    const rec = computer?.recommended?.find((r) => r.rowKey === row.key);
    return {
      rowKey: row.key,
      agentType: row.agentType,
      role: row.role,
      roleLabel: row.roleLabel,
      action: rec?.action ?? "add",
      agentId: rec?.action === "reconnect" ? rec.agentId : null,
    };
  });
}

/** Two OS users or more on this computer: names then carry the seat. */
export function computerHasSeats(
  computer: DeviceRequest["reusableComputers"][number] | undefined,
  seat: string | null | undefined
): boolean {
  const seats = new Set(
    (computer?.agents ?? []).map((a) => a.seat).filter((x) => x != null)
  );
  if (seat) seats.add(seat);
  return seats.size > 1;
}

/** "CRM worker · Claude Code on devbox (· antoine)". */
export function hostedAgentDisplay(
  agent: DeviceHostedAgent,
  computerName: string,
  showSeat: boolean
): string {
  return agent.agentType
    ? agentInComputerName({
        agentType: agent.agentType,
        role: agent.role ?? null,
        name: agent.name,
        hostName: computerName,
        seat: agent.seat ?? null,
        showSeat,
      })
    : agentDisplayName({ name: agent.name, hostName: computerName });
}

/** "seen 2m ago, runs a worker" — what the person checks before a choice. */
export function hostedAgentFacts(
  agent: DeviceHostedAgent,
  ago: (iso: string) => string
): string {
  const seen = agent.lastSeenAt
    ? `seen ${ago(agent.lastSeenAt)}`
    : "never seen";
  const runs = agent.workerServedAt ? ", runs a worker" : "";
  const dead = agent.live === false ? ", no working key" : "";
  return `${seen}${runs}${dead}`;
}

/** The agent a row adds, named as it will be. */
export function rowAgentDisplay(
  row: Pick<DeviceAgentChoice, "agentType" | "role" | "roleLabel">,
  computerName: string,
  seat: string | null | undefined,
  showSeat: boolean
): string {
  return agentInComputerName({
    agentType: row.agentType,
    role: row.role,
    roleLabel: row.roleLabel,
    hostName: computerName,
    seat: seat ?? null,
    showSeat,
  });
}

/** The hosted agents no row re-keys: "these stay as they are". */
export function untouchedAgents(
  req: DeviceRequest,
  reuseId: string | null,
  actions: readonly DeviceAgentChoice[]
): DeviceHostedAgent[] {
  const computer = req.reusableComputers.find((c) => c.id === reuseId);
  const rekeyed = new Set(
    actions.filter((a) => a.action === "reconnect").map((a) => a.agentId)
  );
  return (computer?.agents ?? []).filter((a) => !rekeyed.has(a.id));
}

/** "by OS user "agent" (new on this computer)" — who is asking, when known. */
export function askerLine(
  req: DeviceRequest,
  reuseId: string | null
): string | null {
  const who = seatLine(req.seat ?? null);
  if (!who) return null;
  const computer = req.reusableComputers.find((c) => c.id === reuseId);
  const known = (computer?.agents ?? []).some((a) => a.seat === req.seat);
  return computer && !known ? `by ${who} (new on this computer)` : `by ${who}`;
}

/** The page title: what approving does, in one question. */
export function deviceTitle(
  req: DeviceRequest,
  reuseId: string | null,
  computerName: string,
  actions: readonly DeviceAgentChoice[]
): string {
  const name = computerName.trim() || req.hostname;
  if (!reuseId || !req.rows)
    return reuseId ? `Reconnect ${name}?` : `Connect ${name}?`;
  const kept = actions.filter((a) => a.action !== "skip");
  const adds = kept.filter((a) => a.action === "add");
  const recs = kept.filter((a) => a.action === "reconnect");
  if (kept.length === 0) return `Reconnect ${name}?`;
  if (recs.length === 0)
    return adds.length === 1
      ? `Add an agent to ${name}?`
      : `Add ${adds.length} agents to ${name}?`;
  if (adds.length === 0) {
    if (recs.length > 1) return `Reconnect on ${name}?`;
    const agent = req.reusableComputers
      .find((c) => c.id === reuseId)
      ?.agents?.find((a) => a.id === recs[0]!.agentId);
    return agent
      ? `Reconnect ${hostedAgentDisplay(agent, name, false)}?`
      : `Reconnect on ${name}?`;
  }
  return `Add and reconnect agents on ${name}?`;
}

/** The name the computer gets: the reused one's, else the hostname. */
export function defaultComputerName(
  req: DeviceRequest,
  reuseId: string | null
): string {
  return (
    req.reusableComputers.find((c) => c.id === reuseId)?.name ?? req.hostname
  );
}

/** Every agent the terminal asked for starts checked. */
export function defaultAgents(req: DeviceRequest): string[] {
  return req.agents.map((a) => a.agentType);
}

/** "Claude Code on devbox", live as the person renames the computer. */
export function hostedAgentName(
  agent: DeviceRequest["agents"][number],
  computerName: string
): string {
  return agentDisplayName({ name: agent.name, hostName: computerName });
}

/** "devbox · linux · created 2m ago" — the parts the read actually carries. */
export function computerLine(
  req: DeviceRequest,
  ago: (iso: string) => string
): string {
  return [req.hostname, req.platform, `created ${ago(req.createdAt)}`]
    .filter(Boolean)
    .join(" · ");
}

/**
 * What "Reconnect devbox" keeps and what it stops — the ONE sentence, both
 * surfaces. A reconnect keeps the computer's agents, history and rules, and
 * replaces its keys and its agents' (machine-connect `mintForApprovedRequest`
 * revokes the old ones), so anything still running with an old key stops.
 * Names the kept agents and when each was last seen, when the read carries them.
 */
export function reconnectLine(
  computer: DeviceRequest["reusableComputers"][number],
  ago: (iso: string) => string
): string {
  const agents = computer.agents ?? [];
  const kept =
    agents.length > 0
      ? `Keeps ${agents
          .map(
            (a) =>
              `${a.name} (${a.lastSeenAt ? `seen ${ago(a.lastSeenAt)}` : "never seen"})`
          )
          .join(", ")}, its history and rules.`
      : "Keeps its agents, history and rules.";
  return `${kept} Its agents get new keys: anything still running there with an old key stops and must reconnect.`;
}

/**
 * "devbox gets its own access: …" — the ONE access sentence, both surfaces.
 * It speaks of the COMPUTER's own changes (it starts ask-first); its agents'
 * changes land as the person chose (`agentWriteMode`). Names the key's
 * validity, which the read carries.
 */
export function accessLine(req: DeviceRequest, computerName: string): string {
  const name = computerName.trim() || req.hostname;
  return `${name} gets its own access: it reads your data, and every change it makes itself waits for your approval. Key valid ${req.keyTtlDays} days.`;
}

/**
 * Approving is a HOLD, not a tap, when the access it gives is full or
 * includes approving — the connect card's rule (`danger.full ||
 * danger.approves`), read through the ONE holder reader from the preset the
 * pod names. An access name this build does not know holds: a hold costs a
 * second; a tap on unknown reach costs nothing to undo only by luck.
 */
export function deviceApproveIsHold(req: DeviceRequest): boolean {
  const preset = GRANT_PRESETS.find((p) => p.name === req.accessName);
  if (!preset) return true;
  const access = resolveHolderAccess({
    kind: "agent",
    name: req.hostname,
    limits: {
      source: "grants",
      access: "granted",
      grants: [
        {
          permissions: [...preset.grant.permissions],
          workspaceIds: null,
          projectIds: null,
          entityIds: null,
          expiresAt: null,
        },
      ],
    },
  });
  return access.danger.full || access.danger.approves;
}

/** Approve is offered only while the name it would send is not blank. */
export function canApprove(computerName: string): boolean {
  return computerName.trim().length > 0;
}

export interface ApproveChoice {
  agents: string[];
  /**
   * Per row (a 0395 pod, which served `rows`): add / reconnect / skip.
   * When set, `agents` is derived from it.
   */
  actions?: DeviceAgentChoice[];
  reuseComputerId: string | null;
  computerName: string;
  /**
   * How the kept agents' writes land, from `AGENT_WRITE_MODE_CHOICES`.
   * Omitted (a surface that does not offer the choice yet): the pod starts a
   * new agent ask-first.
   */
  agentWriteMode?: AgentWriteMode;
}

/**
 * "Approve": the computer, the agents kept, reuse-or-new, the name, and how
 * the kept agents' writes land (sent only when the surface offered it and an
 * agent is kept).
 */
export function approveDecision(
  req: DeviceRequest,
  code: string,
  choice: ApproveChoice
): DeviceDecision {
  const name = choice.computerName.trim();
  if (req.rows && choice.actions) {
    const kept = choice.actions.filter((a) => a.action !== "skip");
    const adds = kept.some((a) => a.action === "add");
    return {
      requestId: req.requestId,
      userCode: normalizeCode(code),
      decision: "approve",
      agents: [...new Set(kept.map((a) => a.agentType))],
      reuseComputerId: choice.reuseComputerId,
      computerName: name || null,
      ...(choice.agentWriteMode && adds
        ? { agentWriteMode: choice.agentWriteMode }
        : {}),
      agentActions: choice.actions.map((a) => ({
        agentType: a.agentType,
        role: a.role,
        roleLabel: a.roleLabel,
        action: a.action,
        agentId: a.action === "reconnect" ? a.agentId : null,
        // An add takes the page's choice; a reconnect keeps its own unless
        // the person changed it (D6).
        ...(a.writeMode
          ? { writeMode: a.writeMode }
          : a.action === "add" && choice.agentWriteMode
            ? { writeMode: choice.agentWriteMode }
            : {}),
      })),
    };
  }
  const agents = req.agents
    .map((a) => a.agentType)
    .filter((t) => choice.agents.includes(t));
  return {
    requestId: req.requestId,
    userCode: normalizeCode(code),
    decision: "approve",
    agents,
    reuseComputerId: choice.reuseComputerId,
    computerName: name || null,
    ...(choice.agentWriteMode && agents.length > 0
      ? { agentWriteMode: choice.agentWriteMode }
      : {}),
  };
}

/** "This wasn't me": deny — nothing else rides along. */
export function denyDecision(req: DeviceRequest, code: string): DeviceDecision {
  return {
    requestId: req.requestId,
    userCode: normalizeCode(code),
    decision: "deny",
  };
}

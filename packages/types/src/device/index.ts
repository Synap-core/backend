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
import { MACHINE_AGENT_TYPE, agentDisplayName } from "../agents/index.js";
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
  reusableComputers: Array<{ id: string; name: string; createdAt: string }>;
  keyTtlDays: number;
  accessName: string;
}

/** The input `apiKeys.decideDeviceRequest` takes. */
export interface DeviceDecision {
  requestId: string;
  userCode: string;
  decision: "approve" | "deny";
  agents?: string[];
  reuseComputerId?: string | null;
  computerName?: string | null;
}

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
 * "devbox gets its own access: …" — the ONE access sentence, both surfaces.
 * Names the key's validity, which the read carries.
 */
export function accessLine(req: DeviceRequest, computerName: string): string {
  const name = computerName.trim() || req.hostname;
  return `${name} gets its own access: it reads your data and proposes changes — every change waits for your approval. Key valid ${req.keyTtlDays} days.`;
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
  reuseComputerId: string | null;
  computerName: string;
}

/** "Approve": the computer, the agents kept, reuse-or-new, the name. */
export function approveDecision(
  req: DeviceRequest,
  code: string,
  choice: ApproveChoice
): DeviceDecision {
  const name = choice.computerName.trim();
  return {
    requestId: req.requestId,
    userCode: normalizeCode(code),
    decision: "approve",
    agents: req.agents
      .map((a) => a.agentType)
      .filter((t) => choice.agents.includes(t)),
    reuseComputerId: choice.reuseComputerId,
    computerName: name || null,
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

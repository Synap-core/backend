/**
 * `/device` — the pure model behind the computer-approval page
 * (MACHINE-IDENTITY-PLAN W3). Everything the page decides lives here so a test
 * can run it: which state a read lands in, the default "reconnect or new"
 * choice, and the exact decision the buttons send.
 *
 * Words for domain values come from `@synap-core/types` — the noun ("Computer"),
 * agent names ("Claude Code on devbox") and statuses. Nothing named here.
 */
import { MACHINE_AGENT_TYPE, agentDisplayName } from "@synap-core/types/agents";
import {
  resolveObjectNoun,
  resolveStatusLabel,
} from "@synap-core/types/vocabulary";

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

// ── Read → state ─────────────────────────────────────────────────────────────

/**
 * The read, as the route answers it. A miss (404) and a lock-out (429) are
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

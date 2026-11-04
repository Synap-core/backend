/**
 * Agents inside a computer (plan "Computer once, agents inside" rev 3, pod
 * document 31470fd5, D1): an agent is one per (person, computer, SEAT, ENGINE,
 * ROLE). The seat is the OS user it runs as ("antoine", "agent"); the engine
 * is `agentType` (Claude Code, Codex…); the role is its job ("CRM worker"),
 * NULL for the engine's plain agent. This file is the ONE place their wire
 * grammar and their display are decided: the pod, pod-admin, Relay and the
 * CLI read it.
 */
import { humanizeToken } from "../vocabulary/index.js";
import { resolveServiceName } from "../service-marks/index.js";

/** A job slug: lowercase letters, digits and dashes, 1-63, no leading dash. */
const ROLE_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const AGENT_ROLE_LABEL_MAX = 80;
export const AGENT_SEAT_MAX = 64;

export function isAgentRoleSlug(v: unknown): v is string {
  return typeof v === "string" && ROLE_SLUG.test(v);
}

/** "CRM worker" → "crm-worker"; "" when nothing usable is left. */
export function agentRoleSlug(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
}

/** The label a job shows when none was given: "crm-worker" → "Crm worker". */
export function agentRoleLabel(role: string, label?: string | null): string {
  return label?.trim() || humanizeToken(role);
}

/**
 * A seat a request from an older CLI could not name (it sends no OS user):
 * `unnamed:<8 hex>`. The colon is not allowed in an OS user name (it is the
 * passwd separator), so a real seat can never look like one.
 */
export const UNNAMED_SEAT_PREFIX = "unnamed:";

export function isUnnamedSeat(seat: string | null | undefined): boolean {
  return typeof seat === "string" && seat.startsWith(UNNAMED_SEAT_PREFIX);
}

/** A seat a CLI may send: 1-64 printable characters, no colon, no space. */
export function isValidSeat(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length >= 1 &&
    v.length <= AGENT_SEAT_MAX &&
    // No colon (the passwd separator), no whitespace, nothing unprintable.
    /^[^:\s]+$/.test(v) &&
    [...v].every((ch) => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f)
  );
}

/**
 * The seat of every agent a client reaches through the Synap account (the
 * Control Plane's MCP connector, `/mcp/redeem`): its own identity axis, so it
 * is never the same agent as one `/setup/agent` makes or adopts onto a
 * computer (review bf96d410, lane B). It has a colon, so no CLI can send it
 * (`isValidSeat`), and such an agent runs on no computer, so no door that
 * claims a seat ever writes it.
 */
export const SYNAP_ACCOUNT_SEAT = "synap:account";

export function isSynapAccountSeat(seat: string | null | undefined): boolean {
  return seat === SYNAP_ACCOUNT_SEAT;
}

/** A seat nobody has claimed yet: made before seats, or by an older CLI. */
export function isUnclaimedSeat(seat: string | null | undefined): boolean {
  return seat == null || isUnnamedSeat(seat);
}

/** `OS user "antoine"`, or how an unnamed seat reads. Null for no seat. */
export function seatLine(seat: string | null | undefined): string | null {
  if (seat == null) return null;
  if (isSynapAccountSeat(seat)) return null;
  if (isUnnamedSeat(seat)) return "an OS user an older CLI did not name";
  return `OS user "${seat}"`;
}

/**
 * The ONE display of an agent inside a computer:
 *   - with a role: "CRM worker · Claude Code on devbox";
 *   - without one: "Claude Code on devbox";
 *   - `showSeat` (the computer has more than one seat): "… · agent".
 * `engineName` defaults to the engine's service name.
 */
export function agentInComputerName(input: {
  agentType: string;
  role?: string | null;
  roleLabel?: string | null;
  /** The agent's own name, for a plain agent a person renamed. */
  name?: string | null;
  hostName?: string | null;
  seat?: string | null;
  showSeat?: boolean;
}): string {
  const engine = resolveServiceName(input.agentType);
  const host = input.hostName?.trim();
  const onHost = (n: string) => (host ? `${n} on ${host}` : n);
  const base = input.role
    ? `${agentRoleLabel(input.role, input.roleLabel ?? input.name)} · ${onHost(engine)}`
    : onHost(input.name?.trim() || engine);
  const seat =
    input.showSeat && input.seat
      ? isUnnamedSeat(input.seat)
        ? "unnamed OS user"
        : input.seat
      : null;
  return seat ? `${base} · ${seat}` : base;
}

/**
 * REQUEST WRITE CONTEXT — the ONE request-scoped AsyncLocalStorage in
 * @synap/database. Facts known only at a request's entry door (auth, the MCP
 * adapter), read by floors several layers below that never see the request.
 *
 * ONE store, SEPARATE concerns: each concern owns its field, its entry
 * function and its accessor. Entries MERGE into the current store
 * (`{ ...current, ...patch }`), so nesting composes — an MCP request made with
 * a HUB_TEST key AND a derived session carries both fields.
 *
 * WHY AsyncLocalStorage and not a parameter: the floors (`ProfileRepository
 * .create`, `EntityRepository.create`, session inserts, the project ladder) are
 * where every door converges, and a flag threaded through ~30 doors is a flag
 * one door forgets.
 *
 * WHAT IT DOES NOT COVER: work that leaves the request's async context — a
 * pg-boss job enqueued by the write runs without it; a proposal approved later
 * by a human is a human write.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { sql, type SQL } from "drizzle-orm";
import { PROBE_KEY_SCOPE } from "../schema/api-keys.js";
import { entities } from "../schema/entities.js";
import { PROFILE_ORIGIN_PROBE } from "../schema/profiles.js";

export interface RequestWriteContext {
  /** D8 — the request's key is an explicitly declared probe key. */
  readonly probe?: boolean;
  /** D6 — the key principal is an agent (its user id). */
  readonly actingAgentUserId?: string;
  /** A1 — the session id the MCP door derived (guessed, not named). */
  readonly derivedSessionId?: string;
  /** C1 — which CLIENT is calling (the key it authenticated with). */
  readonly clientKey?: string;
}

const storage = new AsyncLocalStorage<RequestWriteContext>();

/** Run `fn` with `patch` merged over the current store (nesting composes). */
function runWithPatch<T>(patch: RequestWriteContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...patch }, fn);
}

// ═══ Concern: PROBE WRITES (D8) ═══════════════════════════════════════════════
//
// A write made with a probe key is MARKED at the write floor, EXCLUDED from
// listings, and still readable by id.

const PROBE_MARKER_KEY = "probe" as const;

/**
 * THE classification: a key is a probe only when its stored scopes carry the
 * explicit `probe` scope, set by whoever mints the key. Never derived from the
 * key prefix — the minter picks the TEST prefix for any hubId containing
 * "dev"/"test" and for non-production pods, which would hide real writes.
 */
export function isProbeApiKey(
  key: { scope?: readonly string[] | null } | null | undefined
): boolean {
  return key?.scope?.includes(PROBE_KEY_SCOPE) === true;
}

/**
 * Run `fn` with probe marking ON when `isProbe` is true; otherwise run it
 * untouched (no scope entered, so a normal key's writes are byte-identical).
 */
export function runWithProbeWrites<T>(isProbe: boolean, fn: () => T): T {
  return isProbe ? runWithPatch({ probe: true }, fn) : fn();
}

/** True while inside a test-key request's async context. */
export function isProbeWriteContext(): boolean {
  return storage.getStore()?.probe === true;
}

/** `bag` + `probe: true` inside a probe context, else `bag` unchanged. */
export function stampProbeMarker<T extends Record<string, unknown>>(bag: T): T {
  return isProbeWriteContext() ? { ...bag, [PROBE_MARKER_KEY]: true } : bag;
}

/**
 * Drops probe profiles from a listing. Applied at the ONE read floor every
 * profile listing door shares (`ProfileRepository.getAccessibleProfiles`), next
 * to `excludeReservedProfiles`. By-id reads (`getById`) never pass through it.
 */
export function excludeProbeProfiles<T extends { origin?: string | null }>(
  rows: readonly T[]
): T[] {
  return rows.filter((p) => p.origin !== PROFILE_ORIGIN_PROBE);
}

/** SQL predicate for listing doors: entities NOT written by a probe key. */
export function notProbeEntityWhere(): SQL {
  return sql`COALESCE((${entities.systemData}->>'probe')::boolean, false) = false`;
}

// ═══ Concern: ACTING AGENT PRINCIPAL (D6) ═════════════════════════════════════
//
// Entered at the three key-auth doors when the key principal is an agent. The
// `ProfileRepository.create` floor refuses to mint a kind or role under it, so
// no door can forget D6. An approved proposal is materialised by the human who
// approves it, through a door that never enters this scope.

/** Machine-readable reason on the refusal. */
export const AGENT_KIND_REQUIRES_PROPOSAL =
  "AGENT_KIND_REQUIRES_PROPOSAL" as const;

export class AgentKindRequiresProposalError extends Error {
  readonly code = AGENT_KIND_REQUIRES_PROPOSAL;
  constructor(readonly slug: string) {
    super(
      `An agent cannot create the kind/role '${slug}' directly. Define it with ` +
        `synap_define_kind or synap_define_role (REST: POST /api/hub/profiles) — ` +
        `it is filed as a proposal — and retry once a person approves it.`
    );
    this.name = "AgentKindRequiresProposalError";
  }
}

/** Run `fn` with the acting agent recorded; a non-agent key enters no scope. */
export function runWithActingAgent<T>(
  agentUserId: string | undefined,
  fn: () => T
): T {
  return agentUserId
    ? runWithPatch({ actingAgentUserId: agentUserId }, fn)
    : fn();
}

/** The agent principal acting in this request, if any. */
export function getActingAgentUserId(): string | undefined {
  return storage.getStore()?.actingAgentUserId;
}

// ═══ Concern: DERIVED SESSION (A1) ════════════════════════════════════════════
//
// The MCP adapter GUESSES a session when the caller names none (the newest open
// work session). The guess still GROUPS the write, but must never place it into
// a project — `belongs_to_project` widens access. The adapter enters this scope
// ONLY for a derived attribution.

/**
 * HOW a write's `sessionId` was arrived at.
 * - `"explicit"`: the caller NAMED it (an ownership-checked handle, a proposal's
 *   own session, a parent session). It may place the write into its project.
 * - `"derived"`: a door PICKED it — the MCP adapter's newest-session guess, or a
 *   session the permission gate minted/reused. It groups the write, and
 *   contributes NOTHING to project placement.
 * Omitted = decided by {@link isDerivedSession}.
 */
export type SessionSource = "explicit" | "derived";

/** Run `fn` with `sessionId` recorded as the request's GUESSED session. */
export function runWithDerivedSession<T>(sessionId: string, fn: () => T): T {
  return runWithPatch({ derivedSessionId: sessionId }, fn);
}

/** The session id the MCP door derived for this request, if any. */
export function getDerivedSessionId(): string | undefined {
  return storage.getStore()?.derivedSessionId;
}

/**
 * THE rule for whether a write's session is derived. An explicit
 * `sessionSource` always wins; otherwise the session is derived exactly when it
 * IS the id the MCP door guessed for this request. Keyed on the exact id, so a
 * different session named inside the same request is untouched.
 */
export function isDerivedSession(
  sessionId: string | null | undefined,
  sessionSource: SessionSource | undefined
): boolean {
  if (sessionSource !== undefined) return sessionSource === "derived";
  return !!sessionId && sessionId === getDerivedSessionId();
}

// ═══ Concern: CALLING CLIENT (C1) — the CONVERSATION, not the key ════════════
//
// Session-first attribution groups a client's writes into ITS session — never
// into the newest session another client (or the person) opened. "Client" is
// the CONVERSATION: every Claude Code tab on this machine authenticates with
// the SAME `synap init` agent key, so a key-only client poured N concurrent
// conversations into one session and one shared project focus (live: session
// 670f401a, 2026-09-28). Entered at the key-auth doors; read by the session
// resolver, the receipt packager and the focus door several layers below.
//
// NOT entered for the IS's `is_internal` key: one key serves every channel, so
// it would pour all of the IS's conversations into one session. IS writes group
// by their channel (`actingChannelId`, `channel:<id>`) instead.

/** Separator between the key and the conversation inside a client key. */
const CONVERSATION_SEP = "|conv:";

/**
 * A client-supplied conversation id, or undefined when unusable. The MCP
 * transport id is visible ASCII (0x21–0x7E) by spec; the cap keeps a hostile
 * value out of JSONB keys and lock names.
 */
export function normalizeConversationId(
  raw: string | null | undefined
): string | undefined {
  const v = raw?.trim();
  return v && v.length <= 128 && /^[\x21-\x7E]+$/.test(v) ? v : undefined;
}

/**
 * THE client-identity resolver — every key-auth door (MCP, Hub REST) calls it.
 * Precedence:
 *   1. `is_internal` key ⇒ undefined (the IS groups by channel, see above).
 *   2. a conversation id ⇒ `key:<id>|conv:<conversationId>` — CONVERSATION
 *      scope. MCP: the Streamable-HTTP `Mcp-Session-Id` the pod mints at
 *      `initialize` and the client echoes on every request. (No Hub REST / CLI /
 *      Raycast header carries one today; the CLI names its session explicitly
 *      with `X-Session-Id` per Claude tab instead.)
 *   3. otherwise ⇒ `key:<id>` — KEY scope (option A): a write joins a session
 *      only when it names one, else the key's own AUTO-OPENED session, never a
 *      session some conversation on the key STARTED; focus stays per-agent.
 * MCP and Hub REST share the value, so one conversation is one client on both.
 */
export function clientKeyForApiKey(
  key: { id: string; keyType?: string | null },
  conversationId?: string | null
): string | undefined {
  if (key.keyType === "is_internal") return undefined;
  const conv = normalizeConversationId(conversationId);
  return conv ? `key:${key.id}${CONVERSATION_SEP}${conv}` : `key:${key.id}`;
}

/**
 * Whether a client key identifies ONE conversation (`…|conv:…`, or an IS
 * `channel:` — a channel is a conversation) or only a KEY/agent shared by
 * every conversation on it (`key:<id>`, `agent:<id>`). Key scope is option A.
 */
export function clientKeyScope(clientKey: string): "conversation" | "key" {
  return clientKey.includes(CONVERSATION_SEP) ||
    clientKey.startsWith("channel:")
    ? "conversation"
    : "key";
}

/** Run `fn` with the calling client recorded; `undefined` enters no scope. */
export function runWithClientKey<T>(
  clientKey: string | undefined,
  fn: () => T
): T {
  return clientKey ? runWithPatch({ clientKey }, fn) : fn();
}

/** The calling client's key for this request, if a key-auth door set one. */
export function getRequestClientKey(): string | undefined {
  return storage.getStore()?.clientKey;
}

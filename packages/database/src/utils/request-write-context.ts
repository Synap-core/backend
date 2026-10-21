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
import {
  isNarrowedScope,
  type GrantScope,
} from "@synap/governance-policy/grants";

export interface RequestWriteContext {
  /** D8 — the request's key is an explicitly declared probe key. */
  readonly probe?: boolean;
  /** D6 — the key principal is an agent (its user id). */
  readonly actingAgentUserId?: string;
  /** A1 — the session id the MCP door derived (guessed, not named). */
  readonly derivedSessionId?: string;
  /**
   * B4 — set when that derived session is the client's AUTO-OPENED receipt:
   * its project. The gate re-keys a write whose project differs (a receipt is
   * per (client, project)); a session the client started is never re-keyed.
   */
  readonly derivedReceiptProjectId?: string | null;
  /** C1 — which CLIENT is calling (the key it authenticated with). */
  readonly clientKey?: string;
  /** C1 — where the calling conversation runs (a local agent's cwd). */
  readonly conversationCwd?: string;
  /** W1 — what the calling key may touch (absent = a key with no grant). */
  readonly grant?: KeyGrant;
  /** B4 — the sessions this request's writes were FILED under (see below). */
  readonly writeSessions?: WriteSessionLedger;
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

// ═══ Concern: KEY GRANT (W1) ══════════════════════════════════════════════════
//
// The grant bounding the calling API key. Read by the write gate
// (`checkPermissionOrPropose`) and the read floor (`scopedDb`). A key with no
// grant enters no scope; a revoked/expired grant arrives as deny-all.

/**
 * What ONE key may touch: the UNION of its active grant scopes. A request is
 * permitted when ANY scope permits it on its own — scopes never combine, so an
 * app approved for "create People in Sales" and "read Notes in Finance" holds
 * two scopes and can NOT create People in Finance (one flattened scope would
 * have been the cross product). Never empty: a revoked/expired grant arrives as
 * one deny-all scope (`permissions: []`).
 */
export interface KeyGrant {
  readonly scopes: readonly GrantScope[];
  /**
   * The APPLICATION this credential acts as (`grants.client_id` = the app's
   * `public_id`), or null for a bare key. Attribution only — never an
   * enforcement input.
   */
  readonly clientId: string | null;
}

/** A key grant of exactly one scope. */
export function grantOfScope(
  scope: GrantScope,
  clientId: string | null = null
): KeyGrant {
  return { scopes: [scope], clientId };
}

/**
 * True only when EVERY scope is the explicit full-access `*` with NO space,
 * project or object limit — one narrower scope keeps the key fenced (fail
 * closed). A `*` pinned to a workspace used to count as full access here
 * (permissions only), which let it skip the whole scoped-key fence (S1).
 */
export function isFullAccessGrant(grant: KeyGrant): boolean {
  return (
    grant.scopes.length > 0 &&
    grant.scopes.every(
      (s) => s.permissions.includes("*") && !isNarrowedScope(s)
    )
  );
}

/** Run `fn` with the calling key's grant recorded; no grant enters no scope. */
export function runWithGrant<T>(
  grant: KeyGrant | null | undefined,
  fn: () => T
): T {
  return grant ? runWithPatch({ grant }, fn) : fn();
}

/** The grant bounding the calling key, if any. */
export function getRequestGrant(): KeyGrant | undefined {
  return storage.getStore()?.grant;
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

/**
 * Run `fn` with `sessionId` recorded as the request's GUESSED session. Pass
 * `receipt` when it is the client's auto-opened receipt (its project), so the
 * gate can file a write of another project under that project's receipt.
 */
export function runWithDerivedSession<T>(
  sessionId: string,
  fn: () => T,
  receipt?: { projectId: string | null }
): T {
  return runWithPatch(
    receipt
      ? {
          derivedSessionId: sessionId,
          derivedReceiptProjectId: receipt.projectId,
        }
      : { derivedSessionId: sessionId, derivedReceiptProjectId: undefined },
    fn
  );
}

/**
 * The project of the request's derived RECEIPT when `sessionId` is that
 * receipt and the door derived it (not named); `undefined` otherwise — a named
 * session, a started one, or a different id are never re-keyed.
 */
export function derivedReceiptProjectFor(
  sessionId: string | null | undefined
): string | null | undefined {
  const store = storage.getStore();
  if (!sessionId || store?.derivedSessionId !== sessionId) return undefined;
  return store.derivedReceiptProjectId;
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
 *      scope. The client's OWN id when it names one (`X-Synap-Conversation`,
 *      e.g. `claude-code:<uuid>` from the CLI and its stdio MCP bridge — see
 *      `CONVERSATION_HEADER`), else on MCP the Streamable-HTTP `Mcp-Session-Id`
 *      the pod mints at `initialize` and the client echoes on every request.
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

/**
 * The headers a LOCAL agent's client sends to name its own conversation — the
 * one a person can reopen (`claude --resume <id>`), unlike the `Mcp-Session-Id`
 * the pod mints. Value `<harness>:<id>`, e.g. `claude-code:<uuid>`; read by
 * BOTH key-auth doors (MCP, Hub REST) as the conversation half of the client
 * key, so every session that stamps `metadata.clientKey` carries it. Sent by
 * the CLI and its stdio MCP bridge from `CLAUDE_CODE_SESSION_ID`. A hosted
 * chat app (claude.ai, ChatGPT) sends neither: it never exposes its own id.
 */
export const CONVERSATION_HEADER = "x-synap-conversation";
/** Where that conversation runs (its working directory). Display only. */
export const CONVERSATION_CWD_HEADER = "x-synap-conversation-cwd";

/**
 * The conversation id for a request: the client's OWN id when it named one
 * (`X-Synap-Conversation`), else the transport id (MCP `Mcp-Session-Id`).
 */
export function requestConversationId(
  namedByClient: string | null | undefined,
  transportId?: string | null
): string | undefined {
  return (
    normalizeConversationId(namedByClient) ??
    normalizeConversationId(transportId)
  );
}

/** A client-supplied cwd, or undefined when unusable (display only, capped). */
export function normalizeConversationCwd(
  raw: string | null | undefined
): string | undefined {
  const v = raw?.trim();
  // eslint-disable-next-line no-control-regex
  return v && v.length <= 1024 && !/[\x00-\x1F\x7F]/.test(v) ? v : undefined;
}

/**
 * Run `fn` with the calling client recorded; `undefined` enters no scope. The
 * cwd rides only with a client key: it describes that client's conversation.
 */
export function runWithClientKey<T>(
  clientKey: string | undefined,
  fn: () => T,
  conversationCwd?: string | null
): T {
  if (!clientKey) return fn();
  const cwd = normalizeConversationCwd(conversationCwd);
  return runWithPatch(
    cwd ? { clientKey, conversationCwd: cwd } : { clientKey },
    fn
  );
}

/** The calling client's key for this request, if a key-auth door set one. */
export function getRequestClientKey(): string | undefined {
  return storage.getStore()?.clientKey;
}

/** The calling conversation's cwd, when its client named one. */
export function getRequestConversationCwd(): string | undefined {
  return storage.getStore()?.conversationCwd;
}

/**
 * `{ conversationCwd }` to stamp on a session bound to `clientKey` — only when
 * that key IS this request's client (the cwd describes the caller's
 * conversation, never a client key a caller passed in for someone else).
 */
export function conversationCwdPatch(clientKey: string | null | undefined): {
  conversationCwd?: string;
} {
  const store = storage.getStore();
  return clientKey && store?.clientKey === clientKey && store.conversationCwd
    ? { conversationCwd: store.conversationCwd }
    : {};
}

// ═══ Concern: WHERE THE WRITES LANDED (B4 2026-10-21) ═════════════════════════
//
// The MCP door answers every write with the session it was filed under (id +
// name), and a topic hint when it differs from the write's project. The door
// cannot know that up front: a receipt is chosen per write at the governance
// gate, by (client, project). So the gate RECORDS each filing here and the door
// reads the ledger after the handler ran — the reply names what actually
// landed, never a guess made before it.

/** One filing: the session a write was filed under, and the write's project. */
export interface WriteSessionFiling {
  readonly sessionId: string;
  /** The write's own project (explicit, else the conversation's focus); null = none. */
  readonly projectId: string | null;
}

/** Mutable on purpose: one ledger per request, appended to by the gate. */
export interface WriteSessionLedger {
  readonly filings: WriteSessionFiling[];
}

/** Run `fn` with an empty ledger the gate fills; read it with {@link getWriteSessionFilings}. */
export function runWithWriteSessionLedger<T>(fn: () => T): {
  ledger: WriteSessionLedger;
  result: T;
} {
  const ledger: WriteSessionLedger = { filings: [] };
  const result = runWithPatch({ writeSessions: ledger }, fn);
  return { ledger, result };
}

/**
 * Record that a write was filed under `sessionId`. A no-op outside a ledger
 * scope (every door but MCP), and each (session, project) pair once.
 */
export function recordWriteSessionFiling(
  sessionId: string | null | undefined,
  projectId: string | null | undefined
): void {
  const ledger = storage.getStore()?.writeSessions;
  if (!ledger || !sessionId) return;
  const project = projectId ?? null;
  if (
    ledger.filings.some(
      (f) => f.sessionId === sessionId && f.projectId === project
    )
  ) {
    return;
  }
  ledger.filings.push({ sessionId, projectId: project });
}

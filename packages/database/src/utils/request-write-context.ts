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
import { randomUUID } from "node:crypto";
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
  /** C1 — which OS process of that conversation is calling (0373). */
  readonly process?: ProcessIdentity;
  /** 0384 — what that conversation says it is doing, and when the pod heard it. */
  readonly runnerState?: RunnerStateReport;
  /** W1 — what the calling key may touch (absent = a key with no grant). */
  readonly grant?: KeyGrant;
  /** B4 — the sessions this request's writes were FILED under (see below). */
  readonly writeSessions?: WriteSessionLedger;
  /** B7 — the `api_keys.id` the request authenticated with. */
  readonly apiKeyId?: string;
  /** W-B1 — the held-writes pack a person approved, whose writes now replay. */
  readonly heldWritesApprovedBy?: string;
  /** 0364 — the usage middleware's slot, filled by the key-auth doors below. */
  readonly usage?: UsageSlot;
}

/**
 * What the usage middleware (`apps/api/src/middleware/usage-telemetry.ts`)
 * learns from the request's key-auth door. The middleware runs OUTSIDE the
 * door's scope and reads the slot after the response, so the slot is a
 * mutable object the door's entries write into: `runWithCallingKey` sets
 * `apiKeyId`, `runWithClientKey` sets `clientKey`.
 */
export interface UsageSlot {
  apiKeyId?: string;
  clientKey?: string;
}

/** Run `fn` with `slot` open for the key-auth doors to fill. */
export function runWithUsageSlot<T>(slot: UsageSlot, fn: () => T): T {
  return runWithPatch({ usage: slot }, fn);
}

const storage = new AsyncLocalStorage<RequestWriteContext>();

/** Run `fn` with `patch` merged over the current store (nesting composes). */
function runWithPatch<T>(patch: RequestWriteContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...patch }, fn);
}

/**
 * Run `fn` OUTSIDE any request's context: no grant, no calling key, no acting
 * agent. For work a request starts but that answers for OTHER people — the
 * realtime audience of a status move reads each reader's own floor, which the
 * mover's key grant must not narrow (`api/services/status/status-floor.ts`).
 */
export function runOutsideRequestContext<T>(fn: () => T): T {
  return storage.exit(fn);
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
   * `public_id`), or null for a bare key. Attribution, and never a widening:
   * the one place it is enforced TIGHTENS — an app's run of an outward verb
   * always proposes (`@synap/capability-gate`, decision 4A).
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

// ═══ Concern: CALLING KEY (B7) ════════════════════════════════════════════════
//
// WHICH key filed a write. Every Claude Code conversation on one computer
// shares one agent user, so the agent user alone cannot tell two computers'
// work apart; the key can (one agent key per computer, `instance_id`). Entered
// at the two key-auth doors (MCP, Hub REST) for EVERY key — the IS's shared
// internal key too: recording it is true, it simply names no computer. Read
// by the proposal insert doors (`callingKeyAttribution`) and by the B3
// "organising its own fresh work" predicate.

/** Run `fn` with the calling key recorded; no key enters no scope. */
export function runWithCallingKey<T>(
  apiKeyId: string | null | undefined,
  fn: () => T
): T {
  if (!apiKeyId) return fn();
  const slot = storage.getStore()?.usage;
  if (slot) slot.apiKeyId = apiKeyId;
  return runWithPatch({ apiKeyId }, fn);
}

/** The `api_keys.id` this request authenticated with, if a key-auth door set one. */
export function getRequestApiKeyId(): string | undefined {
  return storage.getStore()?.apiKeyId;
}

/**
 * `{ apiKeyId }` to spread onto a `proposals` insert — the ONE way a proposal
 * row records its calling key (column 0346). `{}` outside a key request (a
 * person in the app, a background job), so the column stays NULL there.
 * Every proposal insert door spreads it; a tripwire
 * (`proposal-insert-key-attribution.tripwire.test.ts`) fails on one that
 * does not.
 */
export function callingKeyAttribution(): { apiKeyId?: string } {
  const apiKeyId = getRequestApiKeyId();
  return apiKeyId ? { apiKeyId } : {};
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
// The IS (`is_internal` key, or the pod-signed delegation) is ONE client for
// every channel, so its key alone is never a client: that would pour all of
// the IS's conversations into one session. A channel turn groups by its
// channel (`actingChannelId`, `channel:<id>`). A NON-channel IS run (a skill,
// an automation step, a scan) names itself with `X-Synap-Conversation:
// is:<runId>` (W-A4) and is its own client, `is:<id>|conv:is:<runId>` —
// never the `agent:<id>` fallback every keyless IS write used to pool on.

/** Separator between the key and the conversation inside a client key. */
const CONVERSATION_SEP = "|conv:";

/**
 * Separator between a client and the per-call RUN a door minted for a request
 * that named no conversation (D1, founder 2026-10-23: one receipt session per
 * run; a routine never borrows another run's session). Deliberately NOT
 * `|conv:call:`: a call is one run, but nothing a later request can name, so
 * it is never a runner (`parseRunnerClientKey`) and never reopenable
 * (`conversationOfClientKey`). Its continuity is the `sessionId` handle the
 * write reply hands back (`attribution.filed.handle`).
 */
const CALL_SEP = "|call:";

/** A fresh per-call run of `client` (`key:<id>`, `agent:<id>`). */
export function perCallClientKey(client: string): string {
  return `${client}${CALL_SEP}${randomUUID()}`;
}

/**
 * Whether a client key is a per-call run (`…|call:<uuid>`): ONE run, so it
 * scopes like a conversation, but it carries no conversation a later request
 * shares — so nothing per-conversation (focus, the unclaimed-session guess)
 * may key on it.
 */
export function isPerCallClientKey(clientKey: string): boolean {
  return clientKey.includes(CALL_SEP);
}

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
 *   1. `is_internal` key (the IS) ⇒ `is:<id>|conv:<run>` when the IS named a
 *      run (W-A4, see above), else undefined (it groups by channel). Never a
 *      per-call run, and never `key:` — that prefix means an EXTERNAL client
 *      (`playbook-run-reaper`, `own-fresh-work`, `parseRunnerClientKey`).
 *   2. a conversation id ⇒ `key:<id>|conv:<conversationId>` — CONVERSATION
 *      scope. The client's OWN id when it names one (`X-Synap-Conversation`,
 *      e.g. `claude-code:<uuid>` from the CLI and its stdio MCP bridge — see
 *      `CONVERSATION_HEADER`; or `_meta["live.synap/conversation"]`), else on
 *      MCP the Streamable-HTTP `Mcp-Session-Id` the pod mints at `initialize`
 *      and the client echoes on every request (`requestConversationId`).
 *   3. otherwise ⇒ `key:<id>|call:<uuid>` — a per-call RUN minted here (D1):
 *      this request is its own run, with its own receipt. Two routines on one
 *      key in the same minute (live 2026-10-23) never share a session. It used
 *      to be `key:<id>` (option A), which pooled every such run on the key.
 * MCP and Hub REST share the value, so one conversation is one client on both.
 */
export function clientKeyForApiKey(
  key: { id: string; keyType?: string | null },
  conversationId?: string | null
): string | undefined {
  const conv = normalizeConversationId(conversationId);
  if (key.keyType === "is_internal")
    return conv ? `is:${key.id}${CONVERSATION_SEP}${conv}` : undefined;
  return conv
    ? `key:${key.id}${CONVERSATION_SEP}${conv}`
    : perCallClientKey(`key:${key.id}`);
}

/**
 * Whether a client key identifies ONE conversation or run (`…|conv:…`, a
 * per-call run `…|call:…`, or an IS `channel:` — a channel is a conversation)
 * or only a KEY/agent shared by every run on it (`agent:<id>`, the jobs'
 * fallback, and legacy `key:<id>` rows). Key scope is option A.
 */
export function clientKeyScope(clientKey: string): "conversation" | "key" {
  return clientKey.includes(CONVERSATION_SEP) ||
    isPerCallClientKey(clientKey) ||
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
 * The same two facts as MCP request metadata (`params._meta`), reverse-DNS
 * vendor keys (`io.modelcontextprotocol/` is reserved). Set by our own stdio
 * bridge on every forwarded request, and by any client that cannot set
 * headers. MCP 2026-07-28 removes `Mcp-Session-Id`; these survive it.
 */
export const CONVERSATION_META_KEY = "live.synap/conversation";
export const CONVERSATION_CWD_META_KEY = "live.synap/conversationCwd";

/**
 * The conversation id for a request, first usable of:
 *   1. the client's OWN id in the `X-Synap-Conversation` header — set by our
 *      own transport code, so it wins when both are sent and differ;
 *   2. `_meta["live.synap/conversation"]` on the MCP request;
 *   3. the transport id (MCP `Mcp-Session-Id`, until 2026-07-28).
 * None ⇒ undefined, and `clientKeyForApiKey` mints a per-call run.
 */
export function requestConversationId(
  namedByClient: string | null | undefined,
  namedInMeta?: string | null,
  transportId?: string | null
): string | undefined {
  return (
    normalizeConversationId(namedByClient) ??
    normalizeConversationId(namedInMeta) ??
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
 * Which OS process of a conversation is calling: `<host>:<pid>:<startedAtMs>`.
 * Two live copies of ONE conversation (the same Claude Code session resumed
 * twice) share a client key; this is what tells them apart (0373). Header
 * `X-Synap-Process`, or `_meta["live.synap/process"]`. Telemetry: it never
 * enters the client key, so no session, focus or resume derivation changes.
 */
export const PROCESS_HEADER = "x-synap-process";
export const PROCESS_META_KEY = "live.synap/process";

export interface ProcessIdentity {
  /** The normalised wire value (host lower-cased) — the runner's identity. */
  key: string;
  host: string;
  pid: number;
  /** When the process started. Two copies of a pid on one host differ by it. */
  startedAt: Date;
}

const PROCESS_RE = /^([A-Za-z0-9._-]{1,255}):(\d{1,10}):(\d{10,14})$/;

/** A client-supplied process identity, or undefined when unusable. */
export function parseProcessIdentity(
  raw: string | null | undefined
): ProcessIdentity | undefined {
  const m = PROCESS_RE.exec(raw?.trim() ?? "");
  if (!m) return undefined;
  const startedAt = new Date(Number(m[3]));
  if (Number.isNaN(startedAt.getTime())) return undefined;
  const host = m[1]!.toLowerCase();
  return {
    key: `${host}:${Number(m[2])}:${m[3]}`,
    host,
    pid: Number(m[2]),
    startedAt,
  };
}

/**
 * What a runner (a conversation's process) says it is doing (0384), sent by
 * any harness adapter on any key-auth call: header `X-Synap-Runner-State`, or
 * `_meta["live.synap/runnerState"]` for an MCP client that cannot set headers.
 * `ended` is for a harness that knows its conversation stopped; one that just
 * stops calling leaves the runner live window instead. Telemetry: recorded on
 * that runner's `session_runners` rows, never on the client key.
 */
export const RUNNER_STATE_HEADER = "x-synap-runner-state";
export const RUNNER_STATE_META_KEY = "live.synap/runnerState";
export const RUNNER_STATES = [
  "busy",
  "idle",
  "needs_permission",
  "ended",
] as const;
export type RunnerState = (typeof RUNNER_STATES)[number];

export interface RunnerStateReport {
  state: RunnerState;
  /** When the pod read the report — the order between two reports. */
  reportedAt: Date;
}

/** A client-supplied runner state, or undefined when it names none we know. */
export function parseRunnerState(
  raw: string | null | undefined
): RunnerState | undefined {
  const v = raw?.trim().toLowerCase();
  return RUNNER_STATES.find((s) => s === v);
}

/**
 * Run `fn` with the calling client recorded; `undefined` enters no scope. The
 * cwd, the process and the runner state ride only with a client key: they
 * describe that client's conversation.
 */
export function runWithClientKey<T>(
  clientKey: string | undefined,
  fn: () => T,
  conversationCwd?: string | null,
  processIdentity?: string | null,
  runnerState?: string | null
): T {
  if (!clientKey) return fn();
  const slot = storage.getStore()?.usage;
  if (slot) slot.clientKey = clientKey;
  const cwd = normalizeConversationCwd(conversationCwd);
  const process = parseProcessIdentity(processIdentity);
  const state = parseRunnerState(runnerState);
  return runWithPatch(
    {
      clientKey,
      ...(cwd ? { conversationCwd: cwd } : {}),
      ...(process ? { process } : {}),
      ...(state ? { runnerState: { state, reportedAt: new Date() } } : {}),
    },
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

/** The calling OS process, when its client named one (0373). */
export function getRequestProcess(): ProcessIdentity | undefined {
  return storage.getStore()?.process;
}

/** What the calling runner says it is doing, when its client named it (0384). */
export function getRequestRunnerState(): RunnerStateReport | undefined {
  return storage.getStore()?.runnerState;
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

// ═══ Concern: HELD WRITES APPROVED (W-B1) ═════════════════════════════════════
//
// Past its daily write ceiling an agent's writes are HELD on one pack per UTC
// day. Approving the pack replays each kept write through its own door as the
// agent; the person has answered the ceiling for exactly those writes, so
// rung 2.56 must not hold them again. Every other rung still decides.

/** Run `fn` as the replay of the approved held-writes pack `proposalId`. */
export function runWithHeldWritesApproved<T>(
  proposalId: string,
  fn: () => T
): T {
  return runWithPatch({ heldWritesApprovedBy: proposalId }, fn);
}

/** The approved held-writes pack this write replays, if any. */
export function getHeldWritesApprovedBy(): string | undefined {
  return storage.getStore()?.heldWritesApprovedBy;
}

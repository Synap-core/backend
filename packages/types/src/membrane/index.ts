/**
 * `@synap-core/types/membrane` — the ONE connection state + action rule for
 * everything plugged into the pod that a person meets on Connected.
 *
 * Seven kinds — app, agent, account, channel, tool, model, webhook — used to
 * derive their standing seven different ways (app-view, agent marks, connector
 * card status, tool / channel / provider marks, three local key-status copies).
 * Each kind now maps its OWN wire shape onto nine shared states, and each state
 * carries exactly one primary action, so every surface (desktop, phone, Pod
 * admin) tells the reader the same next step.
 *
 * NOT `@synap-core/types/connections`: that leaf is ENTITY relations.
 *
 * Pure and dependency-free beyond this package's own leaves; safe in Electron,
 * React Native (Hermes), Next.js, the CLI and Node. Returns tone/glyph TOKEN
 * NAMES, never a colour; words come from the vocabulary door.
 */

import {
  resolveAgentMark,
  resolveAgentReachMark,
  type AgentMarkRowLike,
  type AgentReachRowLike,
} from "../agents/index.js";
import type { UnitGlyph, UnitTone } from "../units/state.js";
import {
  CONNECTION_NOTIFY_LABELS,
  CONNECTION_STATE_LABELS,
  resolveActionLabel,
  resolveConnectionStateLabel,
} from "../vocabulary/index.js";

// ── Kinds and states ────────────────────────────────────────────────────────

export const CONNECTION_KINDS = [
  "app",
  "agent",
  "account",
  "channel",
  "tool",
  "model",
  "webhook",
] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

/**
 * The ten states. ORDER IS THE "Needs you" ORDER for the first three; a kind
 * that can never be in a state simply never produces it.
 *
 * `unverified` is the pod failing to READ a connection (its broker faulted),
 * not the connection failing. It exists so a can't-check never folds into
 * `available`: that would offer "Connect" for an account that may be
 * connected and working.
 */
export const CONNECTION_STATES = [
  "asking",
  "needs_signin",
  "failing",
  "setting_up",
  "ready",
  "quiet",
  "off",
  "revoked",
  "unverified",
  "available",
] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

// Compile-time floor: a new state cannot ship without its chip word.
type _StateLabelsCovered =
  Exclude<ConnectionState, keyof typeof CONNECTION_STATE_LABELS> extends never
    ? true
    : never;
const _stateLabelsCovered: _StateLabelsCovered = true;
void _stateLabelsCovered;

/**
 * Allowed, but not used in this many days ⇒ `quiet`. A month: long enough
 * that a monthly job never reads quiet, short enough that a forgotten key is
 * noticed. One number for every kind (agents' 7-day `AGENT_STALE_AFTER_DAYS`
 * is the agent ROSTER mark; on Connected the 30-day rule wins). Matches the
 * chip word "Not seen in 30 days" (`CONNECTION_STATE_LABELS.quiet`).
 */
export const CONNECTION_QUIET_AFTER_DAYS = 30;

const DAY_MS = 86_400_000;

// ── Actions ─────────────────────────────────────────────────────────────────

export const CONNECTION_ACTIONS = [
  "review",
  "approve",
  "decline",
  "reconnect",
  "retry",
  "see_failure",
  "open",
  "rename",
  "pin",
  "unpin",
  "notifications",
  "turn_on",
  "revoke",
  "disconnect",
  "remove",
  "issue_key",
  "add_again",
  "connect",
  "cancel",
] as const;
export type ConnectionAction = (typeof CONNECTION_ACTIONS)[number];

export type ConnectionActionTone = "primary" | "neutral" | "danger";

export interface ConnectionActionSpec {
  action: ConnectionAction;
  /** Button / menu words — imperative mood ("Revoke"). */
  label: string;
  /** Receipt / toast words — past mood ("Revoked"). */
  pastLabel: string;
  tone: ConnectionActionTone;
  /**
   * Ask before doing it. Revoke, Disconnect and Remove always confirm (they
   * cut something that works); Approve never does — the review card IS the
   * confirmation.
   */
  confirm: boolean;
}

/**
 * Which ACTION_VERBS row words each action. A token → token table, not a
 * label map: every word still comes from the vocabulary door.
 */
const ACTION_VERB = {
  review: "review",
  approve: "approve",
  decline: "decline",
  reconnect: "reconnect",
  retry: "retry",
  see_failure: "see_failure",
  open: "open",
  rename: "rename",
  pin: "pin",
  unpin: "unpin",
  notifications: "set_notifications",
  turn_on: "turn_on",
  revoke: "revoke",
  disconnect: "disconnect",
  remove: "remove_for_good",
  issue_key: "issue_key",
  add_again: "add_again",
  connect: "connect",
  cancel: "cancel",
} as const satisfies Record<ConnectionAction, string>;

const DANGER_ACTIONS: ReadonlySet<ConnectionAction> = new Set([
  "revoke",
  "disconnect",
  "remove",
]);
const PRIMARY_TONE_ACTIONS: ReadonlySet<ConnectionAction> = new Set([
  "review",
  "approve",
  "reconnect",
  "turn_on",
  "connect",
  "issue_key",
]);

/** The ONE action rule: words (two moods), tone, and whether it confirms. */
export function resolveConnectionAction(
  action: ConnectionAction
): ConnectionActionSpec {
  const verb = ACTION_VERB[action];
  const danger = DANGER_ACTIONS.has(action);
  return {
    action,
    label: resolveActionLabel(verb, "imperative"),
    pastLabel: resolveActionLabel(verb, "past"),
    tone: danger
      ? "danger"
      : PRIMARY_TONE_ACTIONS.has(action)
        ? "primary"
        : "neutral",
    confirm: danger,
  };
}

/**
 * The danger verb that ends a WORKING connection, by kind: keys are revoked
 * (app), sign-ins are disconnected (agent, account, channel), configuration
 * is removed (tool, model, webhook).
 */
export const CONNECTION_END_ACTION = {
  app: "revoke",
  agent: "disconnect",
  account: "disconnect",
  channel: "disconnect",
  tool: "remove",
  model: "remove",
  webhook: "remove",
} as const satisfies Record<ConnectionKind, ConnectionAction>;

/** What ending a connection DOES: the line beside its danger action, and the sentence inside its confirm. */
export interface ConnectionEndConsequence {
  note: string;
  confirm: string;
}

export interface AppEndConsequenceInput {
  state: ConnectionState;
  /** The app's end verb (`CONNECTION_END_ACTION.app`), or `remove` — the revoked state's next step. */
  action: "revoke" | "remove";
  /** A live key exists. Absent = keys not read, so no key is claimed. */
  hasKey?: boolean;
  /** It holds approved reach. */
  hasReach?: boolean;
}

/**
 * What revoking or removing an app does, true to the pod: revoking withdraws
 * a waiting request, stops its keys and drops its reach (`revokeApp`);
 * removing hides a revoked app for good (`removeApp`) and re-registering the
 * name brings it back. History stays in every case.
 */
export function resolveAppEndConsequence(
  input: AppEndConsequenceInput
): ConnectionEndConsequence {
  const kept = "Its history stays, and you can add it again.";
  if (input.action === "remove") {
    return {
      note: "It leaves your list for good. Its history stays.",
      confirm:
        "It leaves your list for good. Its history stays; registering the same name again brings it back.",
    };
  }
  if (input.state === "asking") {
    return {
      note: "Cancels the request. Its history stays.",
      confirm: `Cancels its request, so it gets nothing. ${kept}`,
    };
  }
  if (input.hasKey) {
    return {
      note: "Its key stops working at once. Its history stays.",
      confirm: `Its key stops working at once and everything it may touch is dropped. ${kept}`,
    };
  }
  if (input.hasReach) {
    return {
      note: "Everything it may touch is dropped. Its history stays.",
      confirm: `Everything it may touch is dropped. ${kept}`,
    };
  }
  return {
    note: "It can no longer ask for access. Its history stays.",
    confirm: `It can no longer ask for access. ${kept}`,
  };
}

/**
 * What disconnecting an AI agent does (`agentUsers.disconnect`): every key it
 * holds is revoked. A key still waiting for approval was never a connection,
 * so it is revoked, not disconnected (`pending`). History stays.
 */
export function resolveAgentEndConsequence(input: {
  pending: boolean;
}): ConnectionEndConsequence {
  if (input.pending) {
    const note =
      "The key waiting for your approval is revoked: it can never call your pod.";
    return {
      note,
      confirm: `${note} To connect later, run the setup command again.`,
    };
  }
  const note =
    "Its keys are revoked: it can no longer call your pod. Its past work stays.";
  return {
    note,
    confirm: `${note} To reconnect, run the setup command again.`,
  };
}

/** What revoking one key does (`apiKeys.revoke`). */
export function resolveKeyEndConsequence(): ConnectionEndConsequence {
  const note = "Anything still using this key stops working at once.";
  return { note, confirm: `${note} This cannot be undone.` };
}

// ── Notify levels ───────────────────────────────────────────────────────────

/** What the person hears about one connection (`connectionPrefs`), in the pod's order. */
export const CONNECTION_NOTIFY_LEVELS = [
  "everything",
  "problems",
  "nothing",
] as const;
export type ConnectionNotifyLevel = (typeof CONNECTION_NOTIFY_LEVELS)[number];

// Compile-time floor: a new level cannot ship without its words.
type _NotifyLabelsCovered =
  Exclude<
    ConnectionNotifyLevel,
    keyof typeof CONNECTION_NOTIFY_LABELS
  > extends never
    ? true
    : never;
const _notifyLabelsCovered: _NotifyLabelsCovered = true;
void _notifyLabelsCovered;

/** The notify choices as a picker shows them, in the pod's order. */
export const CONNECTION_NOTIFY_OPTIONS: ReadonlyArray<{
  id: ConnectionNotifyLevel;
  label: string;
}> = CONNECTION_NOTIFY_LEVELS.map((id) => ({
  id,
  label: CONNECTION_NOTIFY_LABELS[id],
}));

// ── The view ────────────────────────────────────────────────────────────────

export interface ConnectionView {
  kind: ConnectionKind;
  state: ConnectionState;
  tone: UnitTone;
  glyph: UnitGlyph;
  /** The chip word (`resolveConnectionStateLabel`). */
  label: string;
  /** Belongs in the cross-kind "Needs you" group (asking, needs_signin, failing). */
  needsYou: boolean;
  /**
   * Draw a state chip on a ROW. A healthy (`ready`) connection carries none —
   * its presence says it works. Detail pages may still show the mark.
   */
  showChip: boolean;
  /** The one next step, or `null` when the state finishes on its own. */
  primaryAction: ConnectionAction | null;
  /**
   * EVERY action, in the one order: the primary first, then Open, Rename,
   * Pin, Notifications, and the danger action last.
   */
  actions: ConnectionAction[];
}

/** Per-state mark + actions. `END` is substituted by the kind's end verb. */
const STATE_RULES: Record<
  ConnectionState,
  {
    tone: UnitTone;
    glyph: UnitGlyph;
    primary: ConnectionAction | null;
    others: ReadonlyArray<ConnectionAction | "END" | "PIN">;
  }
> = {
  // Ochre = it is asking (your call, nothing broke); warning orange is
  // reserved for "you must act" (a lapsed sign-in or key).
  asking: {
    tone: "primary",
    glyph: "scales",
    primary: "review",
    others: ["open"],
  },
  needs_signin: {
    tone: "warning",
    glyph: "alert",
    primary: "reconnect",
    others: ["open", "END"],
  },
  failing: {
    tone: "error",
    glyph: "alert",
    primary: "see_failure",
    others: ["retry", "END"],
  },
  setting_up: {
    tone: "info",
    glyph: "clock",
    primary: null,
    others: ["cancel"],
  },
  ready: {
    tone: "success",
    glyph: "check",
    primary: "open",
    others: ["rename", "PIN", "notifications", "END"],
  },
  quiet: {
    tone: "textSecondary",
    glyph: "pause",
    primary: "open",
    others: ["END"],
  },
  off: {
    tone: "textMuted",
    glyph: "pause",
    primary: "turn_on",
    others: ["remove"],
  },
  revoked: {
    tone: "textMuted",
    glyph: "lock",
    primary: "remove",
    others: ["add_again"],
  },
  // Neutral, never the error tone and never in "Needs you": nothing is known
  // to be wrong with the connection itself, only that it could not be read.
  // Asking the person again is the one honest step.
  unverified: {
    tone: "textSecondary",
    glyph: "question",
    primary: "retry",
    others: [],
  },
  available: {
    tone: "textMuted",
    glyph: "dashed-circle",
    primary: "connect",
    others: [],
  },
};

const NEEDS_YOU: ReadonlySet<ConnectionState> = new Set([
  "asking",
  "needs_signin",
  "failing",
]);

export interface ConnectionViewOptions {
  /** The person pinned this connection — Pin becomes Unpin. */
  pinned?: boolean;
}

/** Project a state into the full view for a kind. Every resolver ends here. */
export function connectionView(
  kind: ConnectionKind,
  state: ConnectionState,
  opts: ConnectionViewOptions = {}
): ConnectionView {
  const rule = STATE_RULES[state];
  const others = rule.others.map((a) =>
    a === "END"
      ? CONNECTION_END_ACTION[kind]
      : a === "PIN"
        ? opts.pinned
          ? "unpin"
          : "pin"
        : a
  );
  return {
    kind,
    state,
    tone: rule.tone,
    glyph: rule.glyph,
    label: resolveConnectionStateLabel(state, kind),
    needsYou: NEEDS_YOU.has(state),
    showChip: state !== "ready",
    primaryAction: rule.primary,
    actions: rule.primary ? [rule.primary, ...others] : others,
  };
}

/** The cross-kind "Needs you" group, in its order: asking, sign-in, failing. Stable within a state. */
export function needsYouConnections<
  V extends Pick<ConnectionView, "state" | "needsYou">,
>(views: readonly V[]): V[] {
  const rank = (s: ConnectionState) => CONNECTION_STATES.indexOf(s);
  return views
    .map((v, i) => ({ v, i }))
    .filter(({ v }) => v.needsYou)
    .sort((a, b) => rank(a.v.state) - rank(b.v.state) || a.i - b.i)
    .map(({ v }) => v);
}

// ── Shared time helpers ─────────────────────────────────────────────────────

type Instant = string | number | Date | null | undefined;

function ms(value: Instant): number | null {
  if (value == null) return null;
  const t =
    typeof value === "number"
      ? value
      : value instanceof Date
        ? value.getTime()
        : new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Last seen older than the quiet window. An unknown time is NEVER quiet — quiet must be measured. */
function isQuiet(lastSeen: Instant, now: number): boolean {
  const t = ms(lastSeen);
  return t !== null && now - t > CONNECTION_QUIET_AFTER_DAYS * DAY_MS;
}

// ── App ─────────────────────────────────────────────────────────────────────

/** The prefix of every app `public_id` — and so of every app grant's `client_id`. */
export const APP_PUBLIC_ID_PREFIX = "app_";

/**
 * Is this an Application's `public_id` (a grant `client_id` naming an app, not
 * an OAuth `dcr_` client)? `@synap/database` mints with a mirror of this rule
 * (it cannot import this package); `app-public-id-mirror.tripwire` keeps the
 * two identical.
 */
export function isAppPublicId(ref: string | null | undefined): boolean {
  return typeof ref === "string" && ref.startsWith(APP_PUBLIC_ID_PREFIX);
}

/** One key as `apps.get` returns it (camelCase, from `AppRepository.keysFor`). */
export interface AppKeyLike {
  isActive?: boolean | null;
  revokedAt?: string | Date | null;
  expiresAt?: string | Date | null;
  lastUsedAt?: string | Date | null;
}

/** An app's open request for access (the pending `app/connect` proposal). */
export interface AppPendingRequestLike {
  proposal_id: string;
  requests: ReadonlyArray<{ permission: string; workspaceId: string }>;
  requested_at: string;
}

/** What the app rule reads — any `apps.list` / `apps.get` row satisfies it. */
export interface AppConnectionLike {
  revoked_at?: string | Date | null;
  grants: ReadonlyArray<unknown>;
  created_at?: string | Date | null;
  last_used_at?: string | Date | null;
  /** Only on `apps.get`. Absent = not read, so key health is not claimed. */
  keys?: ReadonlyArray<AppKeyLike> | null;
  pending_request?: AppPendingRequestLike | null;
}

/**
 * The app rule, in order:
 *  1. revoked — terminal; nothing it asked or holds matters.
 *  2. asking — an open request outranks its current reach (the person's move).
 *  3. no reach — registered, has not asked yet (or the ask was declined):
 *     `setting_up`; the developer's `synap app connect` finishes it.
 *  4. keys read and none is live, at least one expired ⇒ `needs_signin`
 *     ("Key expired"). Keys absent (`apps.list`) ⇒ not claimed.
 *  5. last used (or, never used, created) past the quiet window ⇒ `quiet`.
 *  6. otherwise `ready`.
 */
export function resolveAppConnectionState(
  app: AppConnectionLike,
  now: number = Date.now()
): ConnectionState {
  if (app.revoked_at) return "revoked";
  if (app.pending_request) return "asking";
  if ((app.grants ?? []).length === 0) return "setting_up";
  if (app.keys && app.keys.length > 0) {
    const live = app.keys.some((k) => {
      if (k.isActive === false || k.revokedAt) return false;
      const exp = ms(k.expiresAt);
      return exp === null || exp > now;
    });
    const expired = app.keys.some((k) => {
      const exp = ms(k.expiresAt);
      return !k.revokedAt && exp !== null && exp <= now;
    });
    if (!live && expired) return "needs_signin";
  }
  const keyUse = (app.keys ?? [])
    .map((k) => ms(k.lastUsedAt))
    .filter((t): t is number => t !== null);
  const lastUse =
    ms(app.last_used_at) ?? (keyUse.length ? Math.max(...keyUse) : null);
  if (isQuiet(lastUse ?? app.created_at, now)) return "quiet";
  return "ready";
}

export function resolveAppConnection(
  app: AppConnectionLike,
  opts: ConnectionViewOptions & { now?: number } = {}
): ConnectionView {
  return connectionView("app", resolveAppConnectionState(app, opts.now), opts);
}

// ── Agent ───────────────────────────────────────────────────────────────────

/**
 * The agent rule reads the ONE agent mark (`resolveAgentMark`) and maps it:
 * approve ⇒ asking; disconnected ⇒ revoked; waiting (a key, never called) ⇒
 * setting_up; noKey ⇒ available; seen/stale ⇒ ready or quiet by the 30-day
 * window; builtIn ⇒ ready. `unmeasured` (an older pod that reports no
 * presence) ⇒ ready: there is no evidence of a problem, and inventing one
 * would put a healthy agent in "Needs you".
 *
 * A BROKEN dispatch binding (`resolveAgentReachMark` → `error`) ⇒ failing,
 * below asking and revoked: Synap cannot send this agent work until the person
 * fixes its connector, so it belongs in "Needs you" however recently the agent
 * itself was seen. A healthy, absent or unserved binding changes nothing.
 */
export function resolveAgentConnectionState(
  row: AgentMarkRowLike & AgentReachRowLike,
  now: number = Date.now()
): ConnectionState {
  const mark = resolveAgentMark(row, now);
  if (mark.kind === "approve") return "asking";
  if (mark.kind === "disconnected") return "revoked";
  if (resolveAgentReachMark(row)?.error) return "failing";
  switch (mark.kind) {
    case "waiting":
      return "setting_up";
    case "noKey":
      return "available";
    case "seen":
    case "stale":
      return isQuiet(mark.seenAt, now) ? "quiet" : "ready";
    case "builtIn":
    case "unmeasured":
    default:
      return "ready";
  }
}

export function resolveAgentConnectionView(
  row: AgentMarkRowLike & AgentReachRowLike,
  opts: ConnectionViewOptions & { now?: number } = {}
): ConnectionView {
  return connectionView(
    "agent",
    resolveAgentConnectionState(row, opts.now),
    opts
  );
}

// ── Can't-check ─────────────────────────────────────────────────────────────

/**
 * Why a connection could not be read — `CapabilityCardConnection.unverified`
 * on the wire. Its presence is the fact; the words are for a detail line.
 */
export interface ConnectionCheckFault {
  reason?: string;
  message?: string;
}

// ── Account (connector sign-ins) ────────────────────────────────────────────

/**
 * An account's facts as the connector surfaces already carry them.
 * `status` takes any of the tokens those derivations emit: the broker status
 * (`connected` / `pending` / `error`), the connector card state
 * (`needs_reauth` / `failed` / `syncing` / `connected` / `pending`), the
 * capability-card connection state (`connected` / `expired` / `missing` /
 * `unavailable`), or `disconnected` / `revoked`.
 */
export interface AccountConnectionLike {
  status: string | null | undefined;
  /** `secrets.connection_state` when the surface has it. */
  connectionState?: string | null;
  /** The account has completed at least one sync. `syncing` before that is setting up. */
  everSynced?: boolean | null;
  /** The card's own sync failed (strip state `failed`). */
  syncFailed?: boolean | null;
  lastSyncedAt?: string | Date | null;
  /**
   * The pod could not read the account (`CapabilityCardConnection.unverified`):
   * the status is the connectable default, not a verdict.
   */
  unverified?: ConnectionCheckFault | boolean | null;
}

/**
 * Order: revoked → asking (admin must approve the install) → needs sign-in →
 * failing → setting up → unverified → available → ready/quiet. An UNKNOWN
 * status is `failing`, never `ready`: calm must be earned by a status we can
 * read. A status the pod could not CHECK (`unverified`, or a capability-card
 * connection carrying `unverified`) is `unverified`, never `available`.
 */
export function resolveAccountConnectionState(
  a: AccountConnectionLike,
  now: number = Date.now()
): ConnectionState {
  const s = (a.status ?? "").toLowerCase();
  if (
    s === "revoked" ||
    s === "disconnected" ||
    a.connectionState === "disconnected"
  )
    return "revoked";
  if (s === "pending") return "asking";
  if (
    s === "error" ||
    s === "needs_reauth" ||
    s === "expired" ||
    a.connectionState === "needs_reauth"
  )
    return "needs_signin";
  if (s === "failed" || a.syncFailed) return "failing";
  if (s === "syncing") return a.everSynced ? "ready" : "setting_up";
  // Only a negative verdict can be unverified: a status that says connected
  // was read, so it stands.
  if (s === "unverified" || (!s && a.unverified)) return "unverified";
  if (s === "missing" || s === "unavailable" || s === "not_connected")
    return a.unverified ? "unverified" : "available";
  if (s === "connected")
    return isQuiet(a.lastSyncedAt, now) ? "quiet" : "ready";
  return "failing";
}

export function resolveAccountConnection(
  a: AccountConnectionLike,
  opts: ConnectionViewOptions & { now?: number } = {}
): ConnectionView {
  return connectionView(
    "account",
    resolveAccountConnectionState(a, opts.now),
    opts
  );
}

// ── Channel (Telegram / WhatsApp / Discord links) ───────────────────────────

/** A `channelGateway.list` row. `null` = a linkable channel with no link. */
export interface ChannelConnectionLike {
  channel: string;
  /** Deliveries that failed since the last success. Absent = not measured. */
  failedDeliveries?: number | null;
  lastMessageAt?: string | Date | null;
}

export function resolveChannelConnectionState(
  link: ChannelConnectionLike | null,
  now: number = Date.now()
): ConnectionState {
  if (!link) return "available";
  if ((link.failedDeliveries ?? 0) > 0) return "failing";
  return isQuiet(link.lastMessageAt, now) ? "quiet" : "ready";
}

export function resolveChannelConnection(
  link: ChannelConnectionLike | null,
  opts: ConnectionViewOptions & { now?: number } = {}
): ConnectionView {
  return connectionView(
    "channel",
    resolveChannelConnectionState(link, opts.now),
    opts
  );
}

// ── Tool (integrations, capabilities, bridges, MCP servers) ─────────────────

export interface ToolConnectionLike {
  /** `tools.status`: active | inactive | error. */
  status?: string | null;
  /** `tools.approved` — born false; an unapproved tool never runs. */
  approved?: boolean | null;
  /** The operator's switch (integration `enabled`). */
  enabled?: boolean | null;
  /** The capability-card connection, when the tool needs one. */
  connection?: {
    required?: boolean;
    state?: string | null;
    /** Set when the pod could not read the connection; `state` is then only the connectable default. */
    unverified?: ConnectionCheckFault | null;
  } | null;
  /** The surface knows this tool's provider needs a reconnect (health mirror). */
  reconnect?: boolean | null;
  lastUsedAt?: string | Date | null;
}

/**
 * Order: off (you turned it off — nothing else matters until it is on) →
 * asking (not approved) → needs sign-in → failing → unverified (its required
 * connection could not be read) → available (needs an account it does not
 * have) → ready/quiet.
 *
 * Known facts outrank a can't-check: an operator switch, an approval, a
 * health-mirror reconnect and a tool error are each read from the pod itself,
 * so they stand even when the broker list did not answer.
 */
export function resolveToolConnectionState(
  t: ToolConnectionLike,
  now: number = Date.now()
): ConnectionState {
  if (t.enabled === false || t.status === "inactive") return "off";
  if (t.approved === false) return "asking";
  const required = t.connection?.required === true;
  const conn = required ? t.connection?.state : null;
  if (t.reconnect || conn === "expired") return "needs_signin";
  if (t.status === "error") return "failing";
  // A required connection with no readable state is unmeasured; calling it
  // ready would claim an account nobody saw.
  if (required && !conn) return "unverified";
  if (conn === "missing" || conn === "unavailable")
    return t.connection?.unverified ? "unverified" : "available";
  return isQuiet(t.lastUsedAt, now) ? "quiet" : "ready";
}

export function resolveToolConnection(
  t: ToolConnectionLike,
  opts: ConnectionViewOptions & { now?: number } = {}
): ConnectionView {
  return connectionView("tool", resolveToolConnectionState(t, opts.now), opts);
}

// ── Capability (a catalog card) ─────────────────────────────────────────────

/**
 * What the capability rule reads — any `capabilities.catalog` card
 * (`CapabilityCard`) satisfies it. `status` is the card's one computed status.
 */
export interface CapabilityConnectionLike {
  /** `installed` | `available` (a template not on the pod yet). */
  source?: string | null;
  /** `CapabilityCardStatus`: available · needs_connection · connected · draft · ready · partial · unavailable. */
  status?: string | null;
  connection?: ToolConnectionLike["connection"];
  lastUsedAt?: string | Date | null;
}

/**
 * A capability is a tool, so it reads the tool rule. Two card facts translate
 * into that rule's inputs: a template not on the pod yet is `available`
 * (adding it is how you connect it), and an installed pack with no verb
 * turned on (`connected` / `draft`) is waiting for the person's approval,
 * exactly as an unapproved tool is.
 */
export function resolveCapabilityConnectionState(
  card: CapabilityConnectionLike,
  now: number = Date.now()
): ConnectionState {
  if (card.source === "available") return "available";
  const awaitingApproval =
    card.status === "connected" || card.status === "draft";
  return resolveToolConnectionState(
    {
      connection: card.connection,
      ...(awaitingApproval ? { approved: false } : {}),
      lastUsedAt: card.lastUsedAt,
    },
    now
  );
}

export function resolveCapabilityConnection(
  card: CapabilityConnectionLike,
  opts: ConnectionViewOptions & { now?: number } = {}
): ConnectionView {
  return connectionView(
    "tool",
    resolveCapabilityConnectionState(card, opts.now),
    opts
  );
}

// ── Connection card (a broker account with its sync rows) ───────────────────

/**
 * The card states `@synap-core/headless/connectors` derives from the broker
 * status and the card's own sync rows (`connectionCardStatus`). Spelled here so
 * the headless type can be pinned equal to it.
 */
export const CONNECTION_CARD_STATES = [
  "pending",
  "needs_reauth",
  "failed",
  "syncing",
  "connected",
] as const;
export type ConnectionCardStateToken = (typeof CONNECTION_CARD_STATES)[number];

/**
 * A connection card is an account, so it reads the account rule: pending →
 * asking, needs_reauth → needs_signin, failed → failing, syncing →
 * setting_up (ready once it has synced before), connected → ready (quiet past
 * the window). Phone and desktop both map through here, so a card's header
 * can never disagree with the same account's row on Connected.
 */
export function resolveConnectionCardState(
  state: ConnectionCardStateToken,
  facts: Pick<AccountConnectionLike, "everSynced" | "lastSyncedAt"> = {},
  now: number = Date.now()
): ConnectionState {
  return resolveAccountConnectionState({ status: state, ...facts }, now);
}

export function resolveConnectionCardConnection(
  state: ConnectionCardStateToken,
  opts: ConnectionViewOptions &
    Pick<AccountConnectionLike, "everSynced" | "lastSyncedAt"> & {
      now?: number;
    } = {}
): ConnectionView {
  const { everSynced, lastSyncedAt, now, ...viewOpts } = opts;
  return connectionView(
    "account",
    resolveConnectionCardState(state, { everSynced, lastSyncedAt }, now),
    viewOpts
  );
}

// ── AI model provider ───────────────────────────────────────────────────────

export interface ModelConnectionLike {
  enabled: boolean;
  /** A key is stored (`ai_providers.encrypted_api_key` is set). */
  hasKey: boolean;
  /** The last probe failed. Absent = never tested, not "fine". */
  lastTestFailed?: boolean | null;
}

/**
 * Order: off (a disabled provider is Off, never "no key" — matches the old
 * `providerMark`) → available (no key: adding one is connecting it) →
 * failing (the last probe failed) → ready. A provider has no "last used", so
 * it is never `quiet`.
 */
export function resolveModelConnectionState(
  m: ModelConnectionLike
): ConnectionState {
  if (!m.enabled) return "off";
  if (!m.hasKey) return "available";
  if (m.lastTestFailed) return "failing";
  return "ready";
}

export function resolveModelConnection(
  m: ModelConnectionLike,
  opts: ConnectionViewOptions = {}
): ConnectionView {
  return connectionView("model", resolveModelConnectionState(m), opts);
}

// ── Webhook ─────────────────────────────────────────────────────────────────

export interface WebhookConnectionLike {
  /** `webhook_subscriptions.active`. */
  active: boolean;
  /** The newest `webhook_deliveries.status` (success | failed | pending), or null = none yet. */
  lastDeliveryStatus?: string | null;
  lastTriggeredAt?: string | Date | null;
}

export function resolveWebhookConnectionState(
  w: WebhookConnectionLike,
  now: number = Date.now()
): ConnectionState {
  if (!w.active) return "off";
  if (w.lastDeliveryStatus === "failed") return "failing";
  return isQuiet(w.lastTriggeredAt, now) ? "quiet" : "ready";
}

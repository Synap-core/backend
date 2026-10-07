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
  type AgentMarkRowLike,
  type AgentMarkTone,
} from "../agents/index.js";
import type { UnitGlyph, UnitTone } from "../units/state.js";
import {
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
 * The nine states. ORDER IS THE "Needs you" ORDER for the first three; a kind
 * that can never be in a state simply never produces it.
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
  asking: {
    tone: "warning",
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
 */
export function resolveAgentConnectionState(
  row: AgentMarkRowLike,
  now: number = Date.now()
): ConnectionState {
  const mark = resolveAgentMark(row, now);
  switch (mark.kind) {
    case "approve":
      return "asking";
    case "disconnected":
      return "revoked";
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
  row: AgentMarkRowLike,
  opts: ConnectionViewOptions & { now?: number } = {}
): ConnectionView {
  return connectionView(
    "agent",
    resolveAgentConnectionState(row, opts.now),
    opts
  );
}

/** The agent mark's tone on the shared tone list, so one chip draws both. */
export function agentToneToUnitTone(tone: AgentMarkTone): UnitTone {
  switch (tone) {
    case "success":
      return "success";
    case "warning":
      return "warning";
    case "danger":
      return "error";
    case "neutral":
    default:
      return "textSecondary";
  }
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
}

/**
 * Order: revoked → asking (admin must approve the install) → needs sign-in →
 * failing → setting up → available → ready/quiet. An UNKNOWN status is
 * `failing`, never `ready`: calm must be earned by a status we can read.
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
  if (s === "missing" || s === "unavailable" || s === "not_connected")
    return "available";
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
  connection?: { required?: boolean; state?: string | null } | null;
  /** The surface knows this tool's provider needs a reconnect (health mirror). */
  reconnect?: boolean | null;
  lastUsedAt?: string | Date | null;
}

/**
 * Order: off (you turned it off — nothing else matters until it is on) →
 * asking (not approved) → needs sign-in → failing → available (needs an
 * account it does not have) → ready/quiet.
 */
export function resolveToolConnectionState(
  t: ToolConnectionLike,
  now: number = Date.now()
): ConnectionState {
  if (t.enabled === false || t.status === "inactive") return "off";
  if (t.approved === false) return "asking";
  const conn = t.connection?.required ? t.connection.state : null;
  if (t.reconnect || conn === "expired") return "needs_signin";
  if (t.status === "error") return "failing";
  if (conn === "missing" || conn === "unavailable") return "available";
  return isQuiet(t.lastUsedAt, now) ? "quiet" : "ready";
}

export function resolveToolConnection(
  t: ToolConnectionLike,
  opts: ConnectionViewOptions & { now?: number } = {}
): ConnectionView {
  return connectionView("tool", resolveToolConnectionState(t, opts.now), opts);
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

export function resolveWebhookConnection(
  w: WebhookConnectionLike,
  opts: ConnectionViewOptions & { now?: number } = {}
): ConnectionView {
  return connectionView(
    "webhook",
    resolveWebhookConnectionState(w, opts.now),
    opts
  );
}

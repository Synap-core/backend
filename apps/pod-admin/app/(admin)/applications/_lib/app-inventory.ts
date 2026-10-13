/**
 * Apps — every way an app connects to the pod, read as ONE list.
 *
 * Three connection models, three doors, one row shape:
 *   • key      — the app holds a pod key and acts as its own agent
 *                (`apps.adminList`, App Connect);
 *   • sign-in  — "Sign in with your pod": a browser app a person signs into,
 *                acting as that person (`applicationConnections.list`);
 *   • mcp      — Claude / MCP through the pod's own OAuth server
 *                (`oauthClients.adminList`).
 *
 * Nothing here decides standing or reach on its own. A key app's standing is
 * the membrane rule (`resolveAppConnectionState`) and its reach the ONE holder
 * reader (`appHolderAccess`); the other two models map their stored status onto
 * the same connection states, so the chip words come from the one vocabulary
 * table (`resolveConnectionStateLabel`). Pure, so the page and the tests read
 * one rule.
 */

import {
  appHolderAccess,
  type AppHolderLike,
} from "@synap-core/types/apps/app-view";
import {
  CONNECTION_QUIET_AFTER_DAYS,
  resolveAppConnectionState,
  type AppConnectionLike,
  type ConnectionState,
} from "@synap-core/types/membrane";
import { summarizeAppConnectRequest } from "@synap-core/types/proposals/intent";
import { resolveConnectionStateLabel } from "@synap-core/types/vocabulary";
import type { StatusKind } from "../../components/status-pill";

// ─── How it connects ─────────────────────────────────────────────────────────

export const APP_VIAS = ["key", "sign-in", "mcp"] as const;
export type AppVia = (typeof APP_VIAS)[number];

/** The "How it connects" chip, and the filter chip of the same model. */
export const VIA_LABEL: Record<AppVia, string> = {
  key: "Key",
  "sign-in": "Sign in with your pod",
  mcp: "Claude/MCP",
};

/** `?via=` → a model; anything else (absent, stale, typo) is the whole list. */
export function parseVia(value: string | null | undefined): AppVia | null {
  return APP_VIAS.includes(value as AppVia) ? (value as AppVia) : null;
}

/**
 * The page of one app. The model is a path segment, so the three id spaces
 * (`app_…` public ids, connection uuids, `dcr_…` client ids) can never land on
 * the wrong door even if two ever spelled the same.
 */
export function appHref(via: AppVia, id: string): string {
  return `/applications/${via}/${encodeURIComponent(id)}`;
}

// ─── Status ──────────────────────────────────────────────────────────────────

/**
 * Connection state → the console's one pill. Ended (`revoked`) is grey, not
 * red: an app someone cut off is a settled fact, not a fault to fix.
 */
const STATE_PILL: Record<ConnectionState, StatusKind> = {
  asking: "stale",
  needs_signin: "stale",
  failing: "down",
  setting_up: "unknown",
  ready: "healthy",
  quiet: "unknown",
  off: "unknown",
  revoked: "unknown",
  available: "unknown",
};

export function statePill(state: ConnectionState): {
  kind: StatusKind;
  label: string;
} {
  return {
    kind: STATE_PILL[state],
    label: resolveConnectionStateLabel(state, "app"),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function time(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const t = (value instanceof Date ? value : new Date(value)).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Live and used ⇒ ready; live but unused for the quiet window ⇒ quiet. Never-used is not quiet. */
function liveState(
  lastUsedAt: Date | string | null | undefined,
  now: number
): ConnectionState {
  const t = time(lastUsedAt);
  return t !== null && now - t > CONNECTION_QUIET_AFTER_DAYS * DAY_MS
    ? "quiet"
    : "ready";
}

// ─── Wire inputs (structural: the pod's rows satisfy them) ───────────────────

interface Person {
  id: string;
  name: string | null;
  email: string | null;
}

export type KeyAppInput = AppConnectionLike &
  AppHolderLike & {
    public_id: string;
    name: string;
    last_used_at?: Date | string | null;
    owner: Person | null;
    workspace_names: Readonly<Record<string, string>>;
  };

export interface SignInInput {
  id: string;
  displayName: string;
  publisherUrl: string | null;
  allowedOrigins: readonly string[];
  status: string;
  lastUsedAt: Date | string | null;
  peopleCount: number;
}

export interface McpClientInput {
  clientId: string;
  clientName: string;
  redirectHosts: readonly string[];
  scopes: readonly string[];
  mintedKeys: number;
  activeKeys: number;
  lastUsedAt: Date | string | null;
  people: ReadonlyArray<Person & { active: boolean }>;
}

// ─── The row ─────────────────────────────────────────────────────────────────

export interface AppRowView {
  via: AppVia;
  /** The model's own id — also `data-row-id`, the `?focus=` target. */
  id: string;
  href: string;
  name: string;
  /** "by <publisher>" when the app says who makes it. */
  publisher: string | null;
  /** The owner's name, or "N people". */
  who: string;
  /** One sentence: what it may reach. */
  reach: string;
  lastUsedAt: Date | string | null;
  state: ConnectionState;
  status: { kind: StatusKind; label: string };
  /** People counted in the header line ("16 people use them"). */
  peopleCount: number;
}

/** A person as a row names them. */
export function personName(p: Person | null | undefined): string | null {
  return p?.name?.trim() || p?.email?.trim() || null;
}

export function peopleWord(n: number): string {
  if (n === 0) return "No one yet";
  return `${n} ${n === 1 ? "person" : "people"}`;
}

/** `https://www.acme.com/x` → `acme.com`; null when it is not a URL. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function keyAppRow(app: KeyAppInput, now = Date.now()): AppRowView {
  const state = resolveAppConnectionState(app, now);
  const owner = personName(app.owner);
  const reach =
    state === "asking" && app.pending_request
      ? `Wants to ${lowerFirst(
          summarizeAppConnectRequest({
            appName: app.name,
            requests: app.pending_request.requests,
            workspaceNames: app.workspace_names,
          })
            .lines.map((l) => l.text)
            .join("; ")
        )}`
      : appHolderAccess(app, { workspaceNames: app.workspace_names, now })
          .sentence;
  return {
    via: "key",
    id: app.public_id,
    href: appHref("key", app.public_id),
    name: app.name,
    publisher: null,
    who: owner ?? "Unknown owner",
    reach,
    lastUsedAt: app.last_used_at ?? null,
    state,
    status: statePill(state),
    peopleCount: owner ? 1 : 0,
  };
}

/** A connection's stored status → its state; approval is live, the rest ended or waiting. */
export function signInState(
  conn: Pick<SignInInput, "status" | "lastUsedAt">,
  now = Date.now()
): ConnectionState {
  switch (conn.status) {
    case "approved":
      return liveState(conn.lastUsedAt, now);
    case "pending":
      return "asking";
    default:
      return "revoked";
  }
}

export const SIGN_IN_REACH = "Sees only what the person who signed in can see";

export function signInRow(conn: SignInInput, now = Date.now()): AppRowView {
  const state = signInState(conn, now);
  return {
    via: "sign-in",
    id: conn.id,
    href: appHref("sign-in", conn.id),
    name: conn.displayName,
    publisher: hostOf(conn.publisherUrl) ?? hostOf(conn.allowedOrigins[0]),
    who: peopleWord(conn.peopleCount),
    reach: SIGN_IN_REACH,
    lastUsedAt: conn.lastUsedAt,
    state,
    status: statePill(state),
    peopleCount: conn.peopleCount,
  };
}

/** A client that ever minted a key and holds none now was cut off; one that never did is still setting up. */
export function mcpState(
  client: Pick<McpClientInput, "activeKeys" | "mintedKeys" | "lastUsedAt">,
  now = Date.now()
): ConnectionState {
  if (client.activeKeys > 0) return liveState(client.lastUsedAt, now);
  return client.mintedKeys > 0 ? "revoked" : "setting_up";
}

/**
 * What a Claude/MCP key may do, from the scopes its client was granted. Its
 * writes run the agent ladder (it is an agent acting for the person), so the
 * sentence never promises they are proposed — the pod's rules decide that.
 */
export function mcpReach(scopes: readonly string[]): string {
  const writes = scopes.some((s) => /(^|[.:])write$/.test(s));
  return writes
    ? "Reads and writes as the person who connected it"
    : "Reads as the person who connected it";
}

export function mcpRow(client: McpClientInput, now = Date.now()): AppRowView {
  const state = mcpState(client, now);
  const people =
    state === "revoked" ? client.people : client.people.filter((p) => p.active);
  return {
    via: "mcp",
    id: client.clientId,
    href: appHref("mcp", client.clientId),
    name: client.clientName,
    publisher: client.redirectHosts[0] ?? null,
    who:
      people.length === 1
        ? (personName(people[0]) ?? peopleWord(1))
        : peopleWord(people.length),
    reach: mcpReach(client.scopes),
    lastUsedAt: client.lastUsedAt,
    state,
    status: statePill(state),
    peopleCount: people.length,
  };
}

/**
 * Live apps first (most recently used on top), then the ones waiting on
 * someone, then the ones that ended — what an owner scans for, in order.
 */
const STATE_RANK: Record<ConnectionState, number> = {
  failing: 0,
  needs_signin: 0,
  ready: 1,
  quiet: 1,
  asking: 2,
  setting_up: 2,
  off: 3,
  available: 3,
  revoked: 4,
};

export function sortRows(rows: readonly AppRowView[]): AppRowView[] {
  return [...rows].sort(
    (a, b) =>
      STATE_RANK[a.state] - STATE_RANK[b.state] ||
      (time(b.lastUsedAt) ?? 0) - (time(a.lastUsedAt) ?? 0) ||
      a.name.localeCompare(b.name)
  );
}

export function buildInventory(
  input: {
    keyApps: readonly KeyAppInput[];
    signIns: readonly SignInInput[];
    clients: readonly McpClientInput[];
  },
  now = Date.now()
): AppRowView[] {
  return sortRows([
    ...input.keyApps.map((a) => keyAppRow(a, now)),
    ...input.signIns.map((c) => signInRow(c, now)),
    ...input.clients.map((c) => mcpRow(c, now)),
  ]);
}

export function countByVia(
  rows: readonly AppRowView[]
): Record<AppVia, number> {
  const out: Record<AppVia, number> = { key: 0, "sign-in": 0, mcp: 0 };
  for (const r of rows) out[r.via] += 1;
  return out;
}

/** "4 active · 16 people use them" — live apps, and the people behind them. */
export function headline(rows: readonly AppRowView[]): string | null {
  const live = rows.filter((r) => r.state === "ready" || r.state === "quiet");
  if (live.length === 0) return null;
  const people = live.reduce((n, r) => n + r.peopleCount, 0);
  const uses = people === 1 ? "person uses them" : "people use them";
  return `${live.length} active · ${people} ${uses}`;
}

// ─── Waiting requests (decided in Review, never here) ────────────────────────

export interface PendingSignIn {
  displayName: string;
  status: string;
}

/**
 * The banner over the list: how many requests wait, and whose. Key apps ask
 * through an `app/connect` proposal; sign-in apps through a connection
 * request. Both are decided in Review — this only counts and names them.
 */
export function pendingSummary(input: {
  keyApps: readonly Pick<
    KeyAppInput,
    "name" | "pending_request" | "revoked_at"
  >[];
  requests: readonly PendingSignIn[];
}): { count: number; line: string } | null {
  const parts = [
    ...input.keyApps
      .filter((a) => a.pending_request && !a.revoked_at)
      .map((a) => `${a.name} wants a key`),
    ...input.requests
      .filter((r) => r.status === "pending")
      .map((r) => `${r.displayName} asks to sign in with your pod`),
  ];
  if (parts.length === 0) return null;
  return { count: parts.length, line: `${parts.join(" · ")}.` };
}

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

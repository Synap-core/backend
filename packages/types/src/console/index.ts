/**
 * Pod Console addresses — the ONE table of console pages a client (the
 * desktop app, Relay, the app kits) may link to, and the pure builder that
 * turns a target into a URL.
 *
 * Why it lives here: `@synap-core/types` is the only package every client and
 * pod-admin all import, so a console path is spelled once. pod-admin's own IA
 * (`apps/pod-admin/lib/console-nav.ts`) stays import-free; the tripwire
 * `apps/pod-admin/__tripwires__/console-nav.test.ts` proves every path below
 * is a real console route, that `focus` / `type` are read by the page they are
 * sent to, and that a page marked `member` never answers a member with
 * `/forbidden`.
 *
 * The console's origin is never guessed: read it from the pod's public
 * `GET /api/account-recovery/doors` (`RecoveryDoors.podAdminUrl`) through
 * {@link publishedConsoleOrigin}. No origin → no console link (hide the verb).
 *
 * Pure + dependency-free — safe in browser, React Native, Node and Next.js.
 */

/** Who may follow a link: `member` pages open for any signed-in pod user. */
export type ConsoleAudience = "admin" | "member";

/** What the person does next on the page — picks the verb's wording. */
export type ConsoleVerb = "review" | "manage" | "see-all";

interface ConsolePage {
  path: string;
  audience: ConsoleAudience;
  /** The page receives `?focus=<id>` and lands on that row. */
  focus: boolean;
  /** The verb for a link to the page itself (a focused row is always "manage"). */
  verb: ConsoleVerb;
}

export const CONSOLE_PAGES = {
  home: { path: "/home", audience: "member", focus: false, verb: "see-all" },
  review: { path: "/review", audience: "member", focus: true, verb: "review" },
  sessions: {
    path: "/sessions",
    audience: "admin",
    focus: true,
    verb: "see-all",
  },
  rules: { path: "/rules", audience: "admin", focus: true, verb: "see-all" },
  runs: { path: "/runs", audience: "admin", focus: true, verb: "see-all" },
  agents: { path: "/agents", audience: "admin", focus: true, verb: "see-all" },
  governance: {
    path: "/governance/agents",
    audience: "admin",
    focus: false,
    verb: "manage",
  },
  computers: {
    path: "/computers",
    audience: "admin",
    focus: true,
    verb: "see-all",
  },
  applications: {
    path: "/applications",
    audience: "admin",
    focus: true,
    verb: "see-all",
  },
  keys: { path: "/keys", audience: "admin", focus: true, verb: "see-all" },
  members: { path: "/members", audience: "admin", focus: true, verb: "manage" },
  sources: { path: "/sources", audience: "admin", focus: true, verb: "manage" },
  marketplace: {
    path: "/marketplace",
    audience: "admin",
    focus: true,
    verb: "manage",
  },
  intelligence: {
    path: "/intelligence",
    audience: "admin",
    focus: false,
    verb: "manage",
  },
  security: {
    path: "/security",
    audience: "admin",
    focus: true,
    verb: "manage",
  },
  backups: {
    path: "/backups",
    audience: "admin",
    focus: false,
    verb: "manage",
  },
  updates: {
    path: "/updates",
    audience: "admin",
    focus: false,
    verb: "manage",
  },
  /** The signed-in person's own sign-in methods and recovery codes. */
  accountSecurity: {
    path: "/settings/security",
    audience: "member",
    focus: false,
    verb: "manage",
  },
  /** The console's sign-in page (public): where a person links Synap Cloud once. */
  signIn: {
    path: "/login",
    audience: "member",
    focus: false,
    verb: "manage",
  },
  /** Every way back into an account (public). */
  recovery: {
    path: "/recovery",
    audience: "member",
    focus: false,
    verb: "manage",
  },
} as const satisfies Record<string, ConsolePage>;

export type ConsolePageId = keyof typeof CONSOLE_PAGES;

type FocusPageId = {
  [K in ConsolePageId]: (typeof CONSOLE_PAGES)[K]["focus"] extends true
    ? K
    : never;
}[ConsolePageId];

/** Review's views (`/review?type=`). */
export const CONSOLE_REVIEW_TYPES = [
  "access",
  "changes",
  "asks",
  "history",
] as const;
export type ConsoleReviewType = (typeof CONSOLE_REVIEW_TYPES)[number];

/** How an app connects — the first segment of `/applications/<via>/<id>`. */
export const CONSOLE_APP_VIAS = ["key", "sign-in", "mcp"] as const;
export type ConsoleAppVia = (typeof CONSOLE_APP_VIAS)[number];

/** One object's own console page, keyed like a page id. */
export const CONSOLE_OBJECT_PAGES = {
  computer: { audience: "admin" },
  application: { audience: "admin" },
  /** Approving an app's connection request is a pod-admin act. */
  connectionRequest: { audience: "admin" },
} as const satisfies Record<string, { audience: ConsoleAudience }>;

export type ConsoleTarget =
  | { page: Exclude<ConsolePageId, FocusPageId> }
  | { page: Exclude<FocusPageId, "review">; focus?: string }
  | { page: "review"; type?: ConsoleReviewType; focus?: string }
  | { page: "computer"; id: string }
  | { page: "application"; via: ConsoleAppVia; id: string }
  | { page: "connectionRequest"; id: string };

// ─── The origin ──────────────────────────────────────────────────────────────

/**
 * `/api/account-recovery/doors` body → the console origin (`https://host`,
 * no trailing slash), or null when absent, not http(s), or unparsable. Never
 * guessed from the pod's host.
 */
export function publishedConsoleOrigin(doorsBody: unknown): string | null {
  if (!doorsBody || typeof doorsBody !== "object") return null;
  return httpOrigin((doorsBody as { podAdminUrl?: unknown }).podAdminUrl);
}

function httpOrigin(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

// ─── The href ────────────────────────────────────────────────────────────────

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

const hasOwn = (o: object, k: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, k);

function isPageId(value: unknown): value is ConsolePageId {
  return typeof value === "string" && hasOwn(CONSOLE_PAGES, value);
}

function query(params: Array<[string, string | null]>): string {
  const pairs = params
    .filter((p): p is [string, string] => p[1] !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return pairs.length ? `?${pairs.join("&")}` : "";
}

/** The path (with query) a target opens, or null when it is malformed. */
export function consolePath(target: ConsoleTarget): string | null {
  const t = target as Record<string, unknown>;
  switch (t.page) {
    case "computer": {
      const id = nonEmpty(t.id);
      return id ? `/computers/${encodeURIComponent(id)}` : null;
    }
    case "application": {
      const id = nonEmpty(t.id);
      const via = CONSOLE_APP_VIAS.find((v) => v === t.via);
      return id && via
        ? `/applications/${via}/${encodeURIComponent(id)}`
        : null;
    }
    case "connectionRequest": {
      const id = nonEmpty(t.id);
      return id ? `/connection-requests/${encodeURIComponent(id)}` : null;
    }
  }
  if (!isPageId(t.page)) return null;
  const page: ConsolePage = CONSOLE_PAGES[t.page];
  const type =
    t.page === "review"
      ? (CONSOLE_REVIEW_TYPES.find((v) => v === t.type) ?? null)
      : null;
  const focus = page.focus ? nonEmpty(t.focus) : null;
  return `${page.path}${query([
    ["type", type],
    ["focus", focus],
  ])}`;
}

/**
 * The full URL for a target on a console origin. null when the origin is not
 * an http(s) URL or the target is malformed — the caller hides the link. Only
 * the params a page reads are emitted; anything else on the target is dropped.
 */
export function consoleHref(
  origin: string | null | undefined,
  target: ConsoleTarget
): string | null {
  const base = httpOrigin(origin);
  const path = base ? consolePath(target) : null;
  return base && path ? `${base}${path}` : null;
}

// ─── Access requests (needs-you rows) ────────────────────────────────────────

/**
 * A needs-you access-request row's `target` → where it is decided: a pending
 * trusted issuer in Review's Access view, an app's connection request on its
 * own page. null for any other kind.
 */
export function accessRequestConsoleTarget(
  target: { kind: string; id: string } | null | undefined
): ConsoleTarget | null {
  if (!target || !nonEmpty(target.id)) return null;
  if (target.kind === "issuer") {
    return { page: "review", type: "access", focus: target.id };
  }
  if (target.kind === "connection-request") {
    return { page: "connectionRequest", id: target.id };
  }
  return null;
}

// ─── Who sees the link, and what it says ─────────────────────────────────────

/**
 * Who may follow a target. Review is a member page, but its Access view holds
 * only decisions a pod admin takes, so a link there is admin-only.
 */
export function consoleTargetAudience(target: ConsoleTarget): ConsoleAudience {
  if (target.page === "review" && target.type === "access") return "admin";
  if (hasOwn(CONSOLE_OBJECT_PAGES, target.page)) {
    return CONSOLE_OBJECT_PAGES[
      target.page as keyof typeof CONSOLE_OBJECT_PAGES
    ].audience;
  }
  return isPageId(target.page) ? CONSOLE_PAGES[target.page].audience : "admin";
}

/** Clients hide admin-only links from members (they would land on /forbidden). */
export function consoleTargetVisibleTo(
  target: ConsoleTarget,
  role: ConsoleAudience
): boolean {
  return role === "admin" || consoleTargetAudience(target) === "member";
}

export function consoleVerb(target: ConsoleTarget): ConsoleVerb {
  if (target.page === "review" || target.page === "connectionRequest") {
    return "review";
  }
  if (!isPageId(target.page)) return "manage";
  return "focus" in target && nonEmpty(target.focus)
    ? "manage"
    : CONSOLE_PAGES[target.page].verb;
}

export const CONSOLE_VERB_LABEL: Readonly<Record<ConsoleVerb, string>> = {
  review: "Review in console",
  manage: "Manage in console",
  "see-all": "See all in console",
};

/**
 * The mark every console link carries after its label: it leaves the app.
 * Render it beside the label (glyph or icon), hidden from screen readers.
 */
export const CONSOLE_LINK_MARK = "↗";

/** "Review in console" / "Manage in console" / "See all in console". */
export function consoleVerbLabel(target: ConsoleTarget): string {
  return CONSOLE_VERB_LABEL[consoleVerb(target)];
}

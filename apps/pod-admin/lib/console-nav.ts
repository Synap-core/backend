/**
 * The Pod Console's information architecture — ONE pure table.
 *
 * Everything that names or addresses a console page reads it: the side nav and
 * phone drawer, the ⌘K palette's category labels and destinations, Home's
 * "Needs you" exits (`DIAGNOSE_DESTINATION`), and the 307s in `next.config.ts`
 * (`consoleRedirects`). A page that moves is edited here once; nothing else
 * can drift, which is the failure the old 10-pill tab strip, the palette's own
 * `tab` strings and Home's hard-coded hrefs had already produced.
 *
 * Deliberately import-free: `next.config.ts` loads this file at build time,
 * outside the app's module graph, so it may not pull in React, lucide or a
 * workspace package. Icons are therefore lucide NAMES, mapped to components by
 * the nav; kind-backed labels are literals pinned to the vocabulary registry by
 * `__tripwires__/console-nav.test.ts`.
 */

export type NavAudience = "admin" | "member";

/** Lucide icon names the nav renders (`side-nav.tsx` maps each to a component). */
export type NavIconName =
  | "House"
  | "Inbox"
  | "MessagesSquare"
  | "Zap"
  | "Activity"
  | "LayoutTemplate"
  | "Building2"
  | "Shapes"
  | "Database"
  | "Bot"
  | "Laptop"
  | "AppWindow"
  | "KeyRound"
  | "Users"
  | "Plug"
  | "Sparkles"
  | "Store"
  | "ShieldCheck"
  | "HardDrive"
  | "RefreshCw"
  | "ScrollText";

/**
 * A URL that used to be this page. Emitted as a temporary (307) redirect: 308s
 * are cached by browsers forever, which is wrong while the IA is being dogfooded.
 * `query` narrows the rule to `?<key>=<value>`; such rules are emitted before the
 * bare-path rule for the same source so the narrow one wins.
 */
export interface LegacyRoute {
  source: string;
  query?: { key: string; value: string };
  /** Defaults to the item's `href`. */
  destination?: string;
}

export interface NavItem {
  id: string;
  href: string;
  label: string;
  icon: NavIconName;
  /** Extra path prefixes that also light this item up (besides `href`). */
  match?: readonly string[];
  legacy?: readonly LegacyRoute[];
  /**
   * The vocabulary registry kind whose PLURAL noun this label is. Pinned by
   * the tripwire, so a registry rename cannot silently fork the nav's word.
   */
  kind?: string;
  /** Who sees it: members get Home + Review (D8); everything else is admin. */
  audience: NavAudience;
}

export interface NavGroup {
  id: string;
  /** null = the ungrouped head of the list (Home, Review). */
  label: string | null;
  items: readonly NavItem[];
}

export const CONSOLE_NAV = [
  {
    id: "main",
    label: null,
    items: [
      {
        id: "home",
        href: "/home",
        label: "Home",
        icon: "House",
        legacy: [{ source: "/overview" }],
        audience: "member",
      },
      {
        id: "review",
        href: "/review",
        label: "Review",
        icon: "Inbox",
        legacy: [
          { source: "/audit", query: { key: "section", value: "queue" } },
          { source: "/audit", query: { key: "section", value: "proposals" } },
        ],
        audience: "member",
      },
    ],
  },
  {
    id: "operate",
    label: "Operate",
    items: [
      {
        id: "sessions",
        href: "/sessions",
        label: "Sessions",
        icon: "MessagesSquare",
        kind: "session",
        audience: "admin",
      },
      {
        id: "rules",
        href: "/rules",
        label: "Rules",
        icon: "Zap",
        kind: "automation",
        audience: "admin",
      },
      {
        id: "runs",
        href: "/runs",
        label: "Runs",
        icon: "Activity",
        kind: "run",
        audience: "admin",
      },
      {
        id: "templates",
        href: "/templates",
        label: "Templates",
        icon: "LayoutTemplate",
        kind: "playbook",
        audience: "admin",
      },
    ],
  },
  {
    id: "data",
    label: "Data",
    items: [
      {
        id: "spaces",
        href: "/workspaces",
        label: "Spaces",
        icon: "Building2",
        kind: "workspace",
        audience: "admin",
      },
      {
        id: "kinds",
        href: "/kinds",
        label: "Kinds",
        icon: "Shapes",
        audience: "admin",
      },
      {
        id: "entities",
        href: "/entities",
        label: "Entities",
        icon: "Database",
        kind: "entity",
        audience: "admin",
      },
    ],
  },
  {
    id: "access",
    label: "Access",
    items: [
      {
        id: "agents",
        href: "/agents",
        label: "Agents",
        icon: "Bot",
        kind: "agent",
        audience: "admin",
      },
      {
        id: "computers",
        href: "/computers",
        label: "Computers",
        icon: "Laptop",
        kind: "machine",
        audience: "admin",
      },
      {
        id: "apps",
        href: "/origins",
        label: "Apps",
        icon: "AppWindow",
        kind: "application",
        audience: "admin",
      },
      {
        id: "keys",
        href: "/keys",
        label: "Keys",
        icon: "KeyRound",
        legacy: [
          {
            source: "/trust-keys",
            query: { key: "section", value: "api-keys" },
          },
        ],
        audience: "admin",
      },
      {
        id: "members",
        href: "/members",
        label: "Members",
        icon: "Users",
        legacy: [{ source: "/people" }],
        audience: "admin",
      },
    ],
  },
  {
    id: "extend",
    label: "Extend",
    items: [
      {
        id: "sources",
        href: "/sources",
        label: "Sources",
        icon: "Plug",
        kind: "source",
        legacy: [{ source: "/connectors" }],
        audience: "admin",
      },
      {
        id: "intelligence",
        href: "/intelligence",
        label: "Intelligence",
        icon: "Sparkles",
        audience: "admin",
      },
      {
        id: "marketplace",
        href: "/marketplace",
        label: "Marketplace",
        icon: "Store",
        audience: "admin",
      },
    ],
  },
  {
    id: "pod",
    label: "Pod",
    items: [
      {
        id: "security",
        href: "/security",
        label: "Pod security",
        icon: "ShieldCheck",
        legacy: [
          {
            source: "/trust-keys",
            query: { key: "section", value: "secrets" },
            destination: "/security?section=secrets",
          },
          { source: "/trust-keys" },
        ],
        audience: "admin",
      },
      {
        id: "backups",
        href: "/backups",
        label: "Backups",
        icon: "HardDrive",
        audience: "admin",
      },
      {
        id: "updates",
        href: "/updates",
        label: "Updates",
        icon: "RefreshCw",
        audience: "admin",
      },
      {
        id: "audit",
        href: "/audit",
        label: "Audit log",
        icon: "ScrollText",
        audience: "admin",
      },
    ],
  },
] as const satisfies readonly NavGroup[];

export type NavId = (typeof CONSOLE_NAV)[number]["items"][number]["id"];

export const NAV_ITEMS: readonly NavItem[] = CONSOLE_NAV.flatMap(
  (g): readonly NavItem[] => g.items
);

const BY_ID = new Map(NAV_ITEMS.map((item) => [item.id, item]));

export function navItem(id: NavId): NavItem {
  // Every `NavId` is a literal from `CONSOLE_NAV`, so the lookup cannot miss.
  return BY_ID.get(id) as NavItem;
}

export function navLabel(id: NavId): string {
  return navItem(id).label;
}

/**
 * An item's href with query params. `?focus=` / `?section=` / `?tab=` are the
 * console's receivers (`use-focus-row`, `UrlTabs`); values are encoded here so
 * no caller hand-builds a query string.
 */
export function navHref(
  id: NavId,
  params?: Record<string, string | undefined>
): string {
  const query = Object.entries(params ?? {})
    .filter((e): e is [string, string] => e[1] !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const href = navItem(id).href;
  return query ? `${href}?${query}` : href;
}

/** True when a viewer with `role` may open (and so see) this item. */
export function navVisibleTo(item: NavItem, role: NavAudience): boolean {
  return role === "admin" || item.audience === "member";
}

/** The groups a viewer sees, empty groups dropped. */
export function navForRole(role: NavAudience): NavGroup[] {
  return CONSOLE_NAV.map((g) => ({
    id: g.id,
    label: g.label,
    items: (g.items as readonly NavItem[]).filter((i) => navVisibleTo(i, role)),
  })).filter((g) => g.items.length > 0);
}

function segmentPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * The item a pathname belongs to: the LONGEST matching prefix across every
 * item's `href` and `match`, on segment boundaries (`/sessions` never lights
 * up for `/sessions-archive`). null when no item owns the path.
 */
export function activeNavId(pathname: string): NavId | null {
  let best: { id: NavId; length: number } | null = null;
  for (const item of NAV_ITEMS) {
    for (const prefix of [item.href, ...(item.match ?? [])]) {
      if (!segmentPrefix(pathname, prefix)) continue;
      if (!best || prefix.length > best.length) {
        best = { id: item.id as NavId, length: prefix.length };
      }
    }
  }
  return best?.id ?? null;
}

// ─── Where other surfaces send people ────────────────────────────────────────

/**
 * A pending trusted issuer is a decision, so it lives in Review — under
 * Access, the filter that holds every request for reach into the pod.
 */
export function pendingIssuerHref(id?: string): string {
  return navHref("review", { type: "access", focus: id });
}

export type SearchCategory =
  | "workspace"
  | "person"
  | "agent"
  | "computer"
  | "issuer"
  | "api-key"
  | "entity"
  | "proposal"
  | "audit";

export interface SearchDestination {
  /** The nav item a result opens; also the palette row's chip. */
  nav: NavId;
  /** The palette's group heading. */
  label: string;
  /** The href for one result id. */
  href: (id: string) => string;
}

/**
 * ⌘K categories → the page that receives them. Two routes are decided by the
 * row, not the category, and stay at the call site: a PENDING issuer goes to
 * Review (`pendingIssuerHref`), and a workspace-scoped API key goes to its
 * workspace's API-keys tab (the pod-wide Keys list skips workspace keys).
 */
export const SEARCH_DESTINATION: Readonly<
  Record<SearchCategory, SearchDestination>
> = {
  workspace: {
    nav: "spaces",
    label: "Spaces",
    href: (id) => navHref("spaces", { focus: id }),
  },
  person: {
    nav: "members",
    label: "Members",
    href: (id) => navHref("members", { focus: id }),
  },
  agent: {
    nav: "agents",
    label: "Agents",
    href: (id) => navHref("agents", { focus: id }),
  },
  // A computer is an object with its own page, so a result opens it.
  computer: {
    nav: "computers",
    label: "Computers",
    href: (id) => `${navHref("computers")}/${encodeURIComponent(id)}`,
  },
  issuer: {
    nav: "security",
    label: "Trusted issuers",
    href: (id) => navHref("security", { focus: id }),
  },
  "api-key": {
    nav: "keys",
    label: "API keys",
    href: (id) => navHref("keys", { focus: id }),
  },
  // The id travels with the link so the list can land on the entity.
  entity: {
    nav: "entities",
    label: "Entities",
    href: (id) => navHref("entities", { focus: id }),
  },
  proposal: {
    nav: "review",
    label: "Proposals",
    href: (id) => navHref("review", { focus: id }),
  },
  audit: {
    nav: "audit",
    label: "Audit events",
    href: (id) => navHref("audit", { focus: id }),
  },
};

/**
 * `diagnose.global` section key → the console page that owns it. Home's row
 * exits and the nav's badges both read this, so a section's row and the badge
 * it raises always point at the same place. Keys are the server's
 * (`packages/api/src/services/diagnose`); the tripwire fails when the server
 * grows one this table does not place.
 */
export const DIAGNOSE_DESTINATION: Readonly<Record<string, NavId>> = {
  review_backlog: "review",
  duplicate_proposals: "review",
  // The approve-rate finding: tuning happens in the app, but the queue it
  // describes is Review's.
  review_queue: "review",
  capabilities: "marketplace",
  failed_flows: "runs",
  stuck_runs: "sessions",
  agent_activity: "agents",
  quality_by_prompt_version: "intelligence",
  schema_hygiene: "kinds",
  schema_contract: "kinds",
};

// ─── next.config.ts ──────────────────────────────────────────────────────────

export interface ConsoleRedirect {
  source: string;
  destination: string;
  permanent: false;
  has?: Array<{ type: "query"; key: string; value: string }>;
}

/**
 * Every `legacy` entry as a Next redirect. Query-narrowed rules come first:
 * Next applies the first matching rule, and `/trust-keys?section=secrets` must
 * not be swallowed by the bare `/trust-keys` rule. The request's own query
 * string (`?focus=…`) is passed through by Next.
 */
export function consoleRedirects(): ConsoleRedirect[] {
  const rules = NAV_ITEMS.flatMap((item) =>
    (item.legacy ?? []).map((legacy): ConsoleRedirect => ({
      source: legacy.source,
      destination: legacy.destination ?? item.href,
      permanent: false,
      ...(legacy.query
        ? {
            has: [
              {
                type: "query",
                key: legacy.query.key,
                value: legacy.query.value,
              },
            ],
          }
        : {}),
    }))
  );
  return [...rules.filter((r) => r.has), ...rules.filter((r) => !r.has)];
}

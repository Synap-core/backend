/**
 * "What needs me?" — `diagnose.global` sections (plus the two admin alerts the
 * old Alerts card read) mapped to the ranked rows Home renders.
 *
 * PURE and DB-free, so the ranking and the link targets are tested at the
 * seam. The page only renders what this returns.
 *
 * Section `detail` is `Record<string, unknown>` on the wire (types.ts in
 * services/diagnose), so every field is read through a narrowing helper: a
 * renamed or missing field degrades the row to its server headline, never to
 * a crash or a fabricated number. An unknown section key renders the same way
 * — headline, no link — because a link we have not verified is worse than none.
 *
 * Where a row goes is decided by `DIAGNOSE_DESTINATION` (lib/console-nav.ts),
 * the same table the nav's badges read, so a row and the badge it raises can
 * never point at different pages.
 */

import {
  DIAGNOSE_DESTINATION,
  navHref,
  navItem,
  navLabel,
  navVisibleTo,
  pendingIssuerHref,
  type NavAudience,
  type NavId,
} from "../../../../lib/console-nav";
import { openIn, type Exit } from "../../../../lib/open-in";

/**
 * `diagnose.global` runs ~a dozen aggregate reads server-side; it is a health
 * snapshot, not a live feed. Two minutes keeps tab switches free without
 * letting the page drift far from what the pod reports. Home AND the nav's
 * badges (`useConsoleBadges`) pass exactly these options, so they share one
 * cached query instead of racing two.
 */
export const DIAGNOSE_QUERY_OPTIONS = { staleTime: 120_000 } as const;

export type HealthStatus = "ok" | "attention" | "degraded";

/** The wire shape of one `diagnose.global` section, widened so a key this
 *  build does not know still typechecks and still renders. */
export interface DiagnoseSection {
  key: string;
  status: HealthStatus;
  headline: string;
  detail: Record<string, unknown>;
}

/** A pending trusted issuer (`trustedIssuers.list`, status `pending`). */
export interface PendingIssuer {
  id: string;
  issuerUrl: string | null;
}

/** A sync peer whose last attempt errored (`sync.getStatus`). */
export interface SyncError {
  id: string;
  label: string;
  error: string;
}

/** One thing the row can list when it expands (names + age, optional link). */
export interface NeedsYouItem {
  id: string;
  label: string;
  meta?: string;
  exit?: Exit;
}

export type NeedsYouAction =
  /** Go somewhere: a console route, or an `openIn` exit. */
  | { kind: "link"; label: string; exit: Exit }
  /** No page owns this — the row opens in place to show its items. */
  | { kind: "expand"; label: string }
  /** Nothing to act on from here (unknown section, or no items). */
  | { kind: "none" };

export interface NeedsYouRow {
  /** Stable React key; also picks the icon (section key or alert kind). */
  key: string;
  tone: Exclude<HealthStatus, "ok">;
  headline: string;
  secondary?: string;
  action: NeedsYouAction;
  items: NeedsYouItem[];
}

export interface NeedsYou {
  rows: NeedsYouRow[];
  /** Rows ranked below the cap — counted, never silently dropped. */
  hiddenCount: number;
  /** The rows behind `hiddenCount`, for the "+N more" disclosure. */
  hiddenRows: NeedsYouRow[];
  /** Sections reporting `ok`, for the "N checks passing" disclosure. */
  passing: Array<{ key: string; headline: string }>;
}

/** How many rows Home shows before "+N more". */
export const NEEDS_YOU_CAP = 7;

/**
 * Importance within one severity. The review queue and what is waiting on an
 * approval come first (only the owner can unblock them), then what is broken
 * (failing flows, stuck runs, sync), then signals that are findings rather
 * than faults. Schema hygiene/contract last: real, but never urgent.
 */
const IMPORTANCE: readonly string[] = [
  "review_backlog",
  "capabilities",
  "failed_flows",
  "stuck_runs",
  "sync_error",
  "trusted_issuer",
  "agent_activity",
  "duplicate_proposals",
  "review_queue",
  "quality_by_prompt_version",
  "schema_hygiene",
  "schema_contract",
];

const SEVERITY: Record<NeedsYouRow["tone"], number> = {
  degraded: 0,
  attention: 1,
};

function consoleRoute(href: string): Exit {
  return { href, isDesktopLink: false };
}

/** The one queue every decision lands in. */
const REVIEW_QUEUE: Exit = consoleRoute(navHref("review"));

/** "Open <page>" to the console page a section belongs to. */
function openPage(
  id: NavId,
  params?: Record<string, string | undefined>
): NeedsYouAction {
  return {
    kind: "link",
    label: `Open ${navLabel(id).toLowerCase()}`,
    exit: consoleRoute(navHref(id, params)),
  };
}

// ── Narrowing readers for `detail` ──────────────────────────────────────────

function num(obj: unknown, key: string): number | null {
  if (!obj || typeof obj !== "object") return null;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(obj: unknown, key: string): string | null {
  if (!obj || typeof obj !== "object") return null;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function list(obj: unknown, key: string): unknown[] {
  if (!obj || typeof obj !== "object") return [];
  const v = (obj as Record<string, unknown>)[key];
  return Array.isArray(v) ? v : [];
}

function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "under an hour" / "5h" / "8 days" — an age a person reads at a glance. */
export function formatAgeHours(hours: number): string {
  if (hours < 1) return "under an hour";
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.floor(hours / 24)} days`;
}

// ── One section → one row ───────────────────────────────────────────────────

type RowBody = Omit<NeedsYouRow, "key" | "tone">;

function expandOrNone(label: string, items: NeedsYouItem[]): NeedsYouAction {
  return items.length > 0 ? { kind: "expand", label } : { kind: "none" };
}

const SECTION_ROWS: Record<string, (s: DiagnoseSection) => RowBody | null> = {
  review_backlog(s) {
    const pending = num(s.detail, "pending");
    if (pending === null) return null;
    // The lensed and author-floored oldest ages range over different
    // populations (global.ts); the older of the two is the honest "oldest".
    const ages = [
      num(s.detail, "oldestAgeHours"),
      num(s.detail, "oldestAgeHoursIncludingOutsideLens"),
    ].filter((h): h is number => h !== null);
    const oldest = ages.length > 0 ? Math.max(...ages) : null;
    const outside = num(s.detail, "mineOutsideLens") ?? 0;
    return {
      headline:
        `${plural(pending, "change")} waiting for review` +
        (oldest !== null ? ` · oldest ${formatAgeHours(oldest)}` : ""),
      secondary:
        outside > 0
          ? `${outside} more of yours sit outside your workspaces`
          : undefined,
      action: { kind: "link", label: "Review", exit: REVIEW_QUEUE },
      items: [],
    };
  },

  capabilities(s) {
    // Verbs, not containers: a verb's own enable is what the execution gate
    // reads (D5) — the container flag the section used to count gated nothing.
    const verbs = num(s.detail, "verbsAwaitingEnable");
    if (verbs === null) return null;
    const caps = num(s.detail, "capabilitiesAwaitingEnable");
    return {
      headline: `${plural(verbs, "installed verb")} not turned on`,
      secondary:
        (caps !== null
          ? `In ${plural(caps, "capability", "capabilities")}. `
          : "") + "Anything that calls them is refused until you turn them on.",
      action: {
        kind: "link",
        label: "Turn on in Marketplace",
        exit: consoleRoute(navHref("marketplace", { tab: "tools" })),
      },
      items: [],
    };
  },

  failed_flows(s) {
    const failing = num(s.detail, "failingFlows");
    if (failing === null) return null;
    const windowDays = num(s.detail, "windowDays");
    const failedTotal = num(s.detail, "failedTotal");
    // The worst flow by name, so the row says WHAT is failing before the
    // reader opens Runs (which lists every flow and its failures).
    let worstName: string | null = null;
    let worstFailed: number | null = null;
    for (const f of list(s.detail, "flows")) {
      const name = str(f, "flowName");
      const failed = num(f, "failedCount");
      if (name && failed !== null && failed > (worstFailed ?? -1)) {
        worstName = name;
        worstFailed = failed;
      }
    }
    return {
      headline:
        `${plural(failing, "flow")} failing` +
        (windowDays !== null ? ` in the last ${windowDays} days` : ""),
      secondary:
        worstName && worstFailed !== null
          ? `“${worstName}” failed ${plural(worstFailed, "time")}`
          : failedTotal !== null
            ? plural(failedTotal, "failed run")
            : undefined,
      action: openPage("runs"),
      items: [],
    };
  },

  stuck_runs(s) {
    const aged = num(s.detail, "count") ?? 0;
    const idle = num(s.detail, "idleCount") ?? 0;
    const threshold = num(s.detail, "thresholdHours");
    const oldest = list(s.detail, "oldest")[0];
    const oldestName = str(oldest, "flowName");
    const oldestAge = num(oldest, "ageHours");
    const headline =
      aged > 0
        ? `${plural(aged, "run")} still going` +
          (threshold !== null ? ` after ${threshold}h` : "") +
          (idle > 0 ? `, ${idle} more idle` : "")
        : `${plural(idle, "run")} running but idle`;
    return {
      headline,
      secondary:
        oldestName && oldestAge !== null
          ? `Oldest: “${oldestName}”, ${formatAgeHours(oldestAge)}`
          : undefined,
      action: openPage("sessions"),
      items: [],
    };
  },

  agent_activity(s) {
    const over = list(s.detail, "overCap").length;
    const near = list(s.detail, "nearCap").length;
    if (over === 0 && near === 0) return null;
    return {
      headline:
        over > 0
          ? `${plural(over, "agent")} hit the daily proposal limit`
          : `${plural(near, "agent")} close to the daily proposal limit`,
      secondary: "Reviewing their proposals frees the queue",
      action: openPage("agents"),
      items: [],
    };
  },

  duplicate_proposals(s) {
    const clusters = list(s.detail, "clusters");
    if (clusters.length === 0) return null;
    return {
      headline: `${plural(clusters.length, "group")} of similar proposals to review together`,
      action: { kind: "link", label: "Review", exit: REVIEW_QUEUE },
      items: [],
    };
  },

  review_queue(s) {
    const rate = num(s.detail, "approveRateOfReviewed");
    const reviewed = num(s.detail, "reviewed");
    return {
      headline: "You approve almost everything the pod asks you",
      secondary:
        rate !== null && reviewed !== null
          ? `${Math.round(rate * 100)}% of ${reviewed} reviewed — the review rules may be asking too much`
          : undefined,
      action: {
        kind: "link",
        label: "Tune rules",
        exit: openIn({ kind: "settings", section: "ai-governance" }),
      },
      items: [],
    };
  },

  schema_hygiene(s) {
    const items: NeedsYouItem[] = [
      ...list(s.detail, "zeroEntityKinds").flatMap((k, i) => {
        const name = str(k, "displayName") ?? str(k, "slug");
        return name
          ? [
              {
                id: str(k, "profileId") ?? `kind-${i}`,
                label: name,
                meta: "no records",
                exit: consoleRoute(
                  navHref("kinds", { focus: str(k, "profileId") ?? undefined })
                ),
              },
            ]
          : [];
      }),
      ...list(s.detail, "neverRunAutomations").flatMap((a) => {
        const id = str(a, "id");
        const name = str(a, "name");
        return id && name
          ? [
              {
                id,
                label: name,
                meta: "rule never ran",
                exit: consoleRoute(
                  navHref("rules", { filter: "never-ran", focus: id })
                ),
              },
            ]
          : [];
      }),
    ];
    return {
      headline: "Some of the pod could be tidied up",
      secondary: s.headline,
      // Two pages own these (empty kinds → Kinds, idle rules → Rules), so the
      // row opens in place and each item links to its own page.
      action: expandOrNone("Show items", items),
      items,
    };
  },

  schema_contract(s) {
    // Kinds lists the schema differences field by field; the row only says
    // that they exist and takes the reader there.
    return {
      headline: "The system schema differs from the seed",
      secondary: s.headline,
      action: openPage("kinds"),
      items: [],
    };
  },
};

function sectionRow(s: DiagnoseSection): NeedsYouRow {
  const tone = s.status === "degraded" ? "degraded" : "attention";
  const page = DIAGNOSE_DESTINATION[s.key];
  const body = SECTION_ROWS[s.key]?.(s) ?? {
    // Unknown key, or a known key whose detail no longer has the fields we
    // read: the server's own headline — linked to the page that owns the
    // section when the nav places it, otherwise not linked at all.
    headline: s.headline,
    action: page ? openPage(page) : ({ kind: "none" } as const),
    items: [],
  };
  return { key: s.key, tone, ...body };
}

/** Whether a viewer may open the page this section's row would lead to. */
function sectionVisibleTo(key: string, audience: NavAudience): boolean {
  const page = DIAGNOSE_DESTINATION[key];
  // A key the nav does not place has no link, so any viewer may read it.
  return !page || navVisibleTo(navItem(page), audience);
}

// ── The two admin alerts the old Alerts card read ───────────────────────────

function issuerRow(issuers: PendingIssuer[]): NeedsYouRow | null {
  if (issuers.length === 0) return null;
  const only = issuers.length === 1 ? issuers[0] : undefined;
  return {
    key: "trusted_issuer",
    tone: "attention",
    headline: only
      ? "A trusted issuer is awaiting approval"
      : `${issuers.length} trusted issuers awaiting approval`,
    secondary: only ? (only.issuerUrl ?? only.id) : undefined,
    action: {
      kind: "link",
      label: "Review",
      // A pending issuer is a decision, so it lands in Review's issuer
      // filter; with one issuer, focus its row.
      exit: consoleRoute(pendingIssuerHref(only?.id)),
    },
    items: [],
  };
}

function syncRow(errors: SyncError[]): NeedsYouRow | null {
  if (errors.length === 0) return null;
  const only = errors.length === 1 ? errors[0] : undefined;
  return {
    key: "sync_error",
    tone: "degraded",
    headline: only
      ? `Sync with ${only.label} is failing`
      : `${errors.length} sync peers are failing`,
    secondary: only ? only.error.slice(0, 80) : undefined,
    // Sources lists connector connections, not sync peers, so no page
    // owns a peer: the row opens in place to show who is failing and why.
    action: { kind: "expand", label: "Show peers" },
    items: errors.map((e) => ({ id: e.id, label: e.label, meta: e.error })),
  };
}

function importance(key: string): number {
  const i = IMPORTANCE.indexOf(key);
  // Unknown keys rank after every known one — shown, never first.
  return i === -1 ? IMPORTANCE.length : i;
}

/**
 * Rank everything that needs the owner: severity first (degraded before
 * attention), then section importance. Capped at `NEEDS_YOU_CAP`; the rest
 * is counted in `hiddenCount`.
 *
 * `audience: "member"` (D8) drops the sections whose page only an admin can
 * open — a row whose one action is a /forbidden is not something the reader
 * can act on. The admin alerts are the caller's to omit: members cannot read
 * issuers or sync peers at all.
 */
export function buildNeedsYou({
  sections,
  pendingIssuers = [],
  syncErrors = [],
  audience = "admin",
}: {
  sections: DiagnoseSection[];
  pendingIssuers?: PendingIssuer[];
  syncErrors?: SyncError[];
  audience?: NavAudience;
}): NeedsYou {
  const rows = [
    ...sections
      .filter((s) => s.status !== "ok" && sectionVisibleTo(s.key, audience))
      .map(sectionRow),
    issuerRow(pendingIssuers),
    syncRow(syncErrors),
  ]
    .filter((r): r is NeedsYouRow => r !== null)
    .sort(
      (a, b) =>
        SEVERITY[a.tone] - SEVERITY[b.tone] ||
        importance(a.key) - importance(b.key)
    );

  return {
    rows: rows.slice(0, NEEDS_YOU_CAP),
    hiddenCount: Math.max(0, rows.length - NEEDS_YOU_CAP),
    hiddenRows: rows.slice(NEEDS_YOU_CAP),
    passing: sections
      .filter((s) => s.status === "ok" && sectionVisibleTo(s.key, audience))
      .map((s) => ({ key: s.key, headline: s.headline })),
  };
}

/**
 * The one-sentence status line above the list, and its overall tone: the worst
 * of the diagnose roll-up (null while it is loading or failed) and every row,
 * so a failing sync peer still turns the line red when diagnose says ok.
 */
export function statusLine(
  diagnoseStatus: HealthStatus | null,
  needsYou: NeedsYou
): { tone: HealthStatus; sentence: string } {
  const count = needsYou.rows.length + needsYou.hiddenCount;
  const tone: HealthStatus =
    diagnoseStatus === "degraded" ||
    needsYou.rows.some((r) => r.tone === "degraded")
      ? "degraded"
      : diagnoseStatus === "attention" || count > 0
        ? "attention"
        : "ok";
  return {
    tone,
    sentence:
      count === 0
        ? "All good — nothing needs you right now."
        : `${plural(count, "thing")} ${count === 1 ? "needs" : "need"} you.`,
  };
}

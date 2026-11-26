/**
 * What each HOST APP (the desktop browser, the relay phone app) keeps off its
 * default path — the SSOT for "this app or tab left the default path, here's
 * why, here's what replaced it" (V1 plan, Synap doc 31de1f4c,
 * §4 "Deprecation mechanism", decided 2026-09-28).
 *
 * WHY THIS EXISTS. V1 narrows the browser rail to Home/Work/Data and the relay
 * bar to Home/+/Work. Several existing apps/tabs/sections are NOT deleted —
 * "nothing is deleted" (plan decision F4) — they just leave the default
 * navigation, with a recorded reason and a pointer to what replaced them, so a
 * future agent (or founder) doesn't silently re-add a surface the plan
 * deliberately moved off the rail.
 *
 * WHAT THIS DOES NOT DO (yet). This wave (W0) only builds the registry +
 * banners + a tripwire that the registered ids exist and are banner-marked.
 * Actually EXCLUDING these ids from the rail/tab-bar/palette defaults is W3
 * ("Rail & bar") — until then this is documentation + a guard against
 * forgetting, not enforcement.
 *
 * Pure + dependency-free — safe to import from browser (Electron), relay
 * (React Native), CLI, or server contexts (same contract as `./vocabulary`).
 */

// NAME (founder, 23 Nov 2026): this registry was `@synap-core/types/surfaces`
// `DEPRECATED_SURFACES`. "Surface" now means UI anchored to an object (the
// Surface model in `../surfaces`); a browser app or a relay tab is a place in
// a HOST app. The old names stay exported from `../surfaces` as aliases.

/** A host app: the desktop browser or the relay phone app. */
export type HostApp = "browser" | "relay";

export interface DeprecatedInHost {
  /**
   * The id a reader can grep for on the surface's own side:
   * - browser: a `browser/electron/renderer/src/apps/manifest.ts` app id
   * - relay: a relay tab id (`MobileTabId`) OR, when the deprecated thing is
   *   not a route but a section mounted on another screen (e.g. Home's Idea
   *   Studio), a descriptive id that the banner comment on that section names
   *   verbatim — see `decisionDoc` / `reason` for which case applies.
   */
  id: string;
  host: HostApp;
  /** ISO date the deprecation was decided. */
  since: string;
  reason: string;
  replacedBy: string;
  decisionDoc: string;
}

const V1_PLAN_DOC = "Synap doc 31de1f4c — V1 plan";
const SINCE = "2026-09-28";

/**
 * Every surface the V1 plan (§2 "V1 surface map") marks DEPRECATE, as of the
 * plan's W0 wave. Add a row here — never delete one, even once a surface is
 * physically removed later; a removed surface still needs its history
 * recorded for anyone who greps for the old id.
 */
export const DEPRECATED_IN_HOSTS: readonly DeprecatedInHost[] = [
  // ── browser (Electron) ────────────────────────────────────────────────
  {
    id: "governance",
    host: "browser",
    since: SINCE,
    // Founder 2A (2026-10-19): the needs-you list left Work for its own page,
    // the Inbox (`inbox` app) — the row's successor follows it.
    reason:
      "Governance app deprecated: it merges into the Inbox (needs-you) and Settings (Agents, Approvals, History). Its System tab is retired outright.",
    replacedBy: "Inbox; Settings › AI & agents",
    decisionDoc: V1_PLAN_DOC,
  },
  // `processors` (Operations) left this registry: it was DELETED from the
  // browser (Process wave plan 0adf8352 W4), its id aliased to Processes. A
  // retired app is not a deprecated one (the browser tripwire requires every
  // id here to keep a manifest entry).
  {
    id: "activity",
    host: "browser",
    since: SINCE,
    reason:
      "Activity app entry (already folded into Operations/`processors` in 2026-08-19 and aliased via APP_ID_ALIASES) is deprecated alongside `processors` itself.",
    replacedBy: "Work › Activity",
    decisionDoc: V1_PLAN_DOC,
  },
  {
    id: "work-map",
    host: "browser",
    since: SINCE,
    reason:
      "Work map deprecated AS A STANDALONE APP: it lives on as a view, Work › Map, and on project pages.",
    replacedBy: "Work › Map",
    decisionDoc: V1_PLAN_DOC,
  },

  {
    // Founder 2A (2026-10-19, "Library = Data + Files + Import"): the capture
    // Library left the default path to become a TAB of the one Library (the
    // `data` app). The id, its alias (`library` → `import`) and its deep links
    // stay: an open of it lands on Library › Kept with the same address.
    id: "import",
    host: "browser",
    since: "2026-10-19",
    reason:
      "The capture Library (links, pages and files you kept) is a tab of the one Library: Library = Data + Files + Import (founder decision 2A).",
    replacedBy: "Library › Kept",
    decisionDoc: "Synap experience north star (2026-10-19), decision 2A",
  },

  {
    // Founder decision (2026-10-19), completing 2A: the Files app left the
    // default path too — its body already IS Library › Documents. The id and
    // its deep links stay; an open lands on that tab with the same address.
    id: "files",
    host: "browser",
    since: "2026-10-19",
    reason:
      "The Files app (documents and whiteboards) is a tab of the one Library: Library = Data + Files + Import (founder decision 2A).",
    replacedBy: "Library › Documents",
    decisionDoc: "Synap experience north star (2026-10-19), decision 2A",
  },

  // ── relay (React Native) ──────────────────────────────────────────────
  {
    id: "rules",
    host: "relay",
    since: SINCE,
    // ⚠️ Corrected 2026-10-05 (founder, linkage rework decision 4). This row
    // read "moves to Settings › Trust rules": a misattribution — the tab is the
    // AUTOMATION rules inventory, while Settings › Approvals (was "Trust
    // rules") is the governance policy list, a different object. The tab
    // stays retired; what replaced it is where a rule reaches the phone.
    reason:
      "Rules tab deprecated: a rule's proposals are approved in Needs you; rules are authored on the desktop Rules page. Not Settings › Approvals, which governs AI writes, not rules (decision D3, corrected 2026-10-05).",
    replacedBy: "Home › Needs you (rule proposals); desktop Rules page",
    decisionDoc: V1_PLAN_DOC,
  },
  {
    id: "feed",
    host: "relay",
    since: SINCE,
    reason:
      'Feed/Activity tab deprecated: folds into Home\'s "See all activity"; its needs-you lens is retired (Home already surfaces needs-you).',
    replacedBy: "Home › See all activity",
    decisionDoc: V1_PLAN_DOC,
  },
  {
    id: "idea-studio",
    host: "relay",
    since: SINCE,
    reason:
      "Idea Studio section on Home deprecated: a content cockpit on the supervise surface is a fork of the brief. It returns as a RENDERER BOUND TO AN ENTITY KIND, not as a workspace template and not as a Home section.",
    // ⚠️ This was recorded as `replacedBy: "Templates (market)"`, which named
    // the wrong destination and made the section look like dead code waiting to
    // be deleted. It is neither a template nor dead: the substrate it needs
    // already ships — `profiles.getEffectiveRenderers({ profileSlug,
    // contentKind })`, with `entity-detail-task` as the worked precedent for a
    // native renderer over one kind. Do NOT delete the unmounted section in
    // home.tsx on the strength of this row; it is the reference implementation
    // for that renderer. Corrected 2026-10-01 (founder).
    replacedBy: "A native entity renderer bound to the content-creation kind",
    decisionDoc: V1_PLAN_DOC,
  },
  {
    id: "gallery",
    host: "relay",
    since: SINCE,
    // ⚠️ WHAT IS DEPRECATED IS THE PATH, NOT DATA BROWSING. This row used to
    // read "data browsing is a desktop job (Data app)" and name the desktop app
    // as the replacement. The founder then put the entity browser on the phone
    // as a first-class `data` tab (2026-10-01), so a reader of this registry —
    // human or agent — was being told the phone has no data browser when it
    // does. The registry's job is to keep people OFF a retired path, not to
    // retire a capability; keep those two apart here.
    //
    // The `gallery` ROUTE stays registered because its door is held outside
    // this repo (compiled iOS widget extensions opening `relay://gallery`).
    // It is a redirect now, not a tab: `app/gallery.tsx` lands on Library ›
    // Things, and a stored `gallery` / `data` tab value reads as `library`
    // (wave O, founder decision 2, 2026-10-19 — the Library is the one
    // collection on the phone).
    reason:
      "The gallery PATH is superseded by the Library tab (Things); the route stays only as a redirect for installed widgets and deep links.",
    replacedBy: "Library › Things on the phone, and the desktop Library",
    decisionDoc: V1_PLAN_DOC,
  },
  {
    // Wave "one timeline for Work" (founder yes, 16 Nov 2026; 4 Nov surface
    // rule: on the phone, goals only behind details). The tab id stays `work`
    // because people's stored tab settings and space layouts name it; the
    // route `/work` redirects to the Goals collection `/goals`, where the
    // Monday desk moved, and a stored `work` tab id reads as Home
    // (`RETIRED_TAB_IDS`, relay `src/lib/shell-mode.ts`).
    id: "work",
    host: "relay",
    since: "2026-11-16",
    reason:
      "The Goals tab (tab id `work`) left the bar: on the phone goals sit behind details. `/work` redirects to the Goals collection, which holds the Monday desk and the same attention groups.",
    replacedBy: "Goals (`/goals`), reached from Home",
    decisionDoc:
      "Synap doc 5207fbb6 — one timeline for Work (founder, 16 Nov 2026)",
  },
  // `pipeline` (relay classic-shell kanban) left this registry on 2026-10-14:
  // its route, tab id and template slot were DELETED (projects as places), so
  // there is nothing left to keep people off.
];

/** What a host app keeps off its default path. */
export function deprecatedInHost(host: HostApp): readonly DeprecatedInHost[] {
  return DEPRECATED_IN_HOSTS.filter((s) => s.host === host);
}

/** Is this id (an app id, a tab id) kept off the host app's default path? */
export function isDeprecatedInHost(host: HostApp, id: string): boolean {
  return DEPRECATED_IN_HOSTS.some((s) => s.host === host && s.id === id);
}

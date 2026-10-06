/**
 * THE FIVE ATTENTION CLASSES, THE SECTION ORDER, THE CAPS — one table each.
 *
 * Every row on a lens page is exactly one class (skill `lens-page` §2):
 *
 *   blocking  — something waits on YOU; ignoring it stops work.
 *   proposed  — the AI suggests; ignoring it costs nothing.
 *   happening — an agent is working now.
 *   produced  — what work made.
 *   happened  — what changed (work + data).
 *
 * The founder-approved boundary (2026-10-04) between the first two:
 * "Proposed" = AI suggestions + agent DRAFTS. Every pending approval —
 * including a proposal an agent is paused on — is BLOCKING. System health is
 * neither: it is ONE deduplicated status banner ({@link placeSignal} → `banner`).
 */

/** In SECTION order (the order {@link LENS_SECTION_ORDER} draws them). */
export const ATTENTION_CLASSES = [
  "blocking",
  "happening",
  "produced",
  "proposed",
  "happened",
] as const;
export type AttentionClass = (typeof ATTENTION_CLASSES)[number];

/**
 * Below the top, in this order, at every scope (skill §3). Produced sits above
 * Happened because outcomes outrank process; Proposed sits below the work
 * because ignoring it is free. `structure` (Map | Steps | Zoom) exists only on
 * a project / track lens; `data` only where the scope owns data.
 */
export const LENS_SECTION_ORDER = [
  "blocking",
  "happening",
  "produced",
  "structure",
  "proposed",
  "happened",
  "data",
] as const;
export type LensSection = (typeof LENS_SECTION_ORDER)[number];

/** The section headings — one spelling for the header's count doors AND the sections. */
export const LENS_SECTION_LABELS = {
  blocking: "Needs you",
  happening: "Happening",
  produced: "Produced",
  // The work-structure slot (Map | Steps | Zoom) is the PLAN (founder default,
  // 2026-10-05): "Work" already names the app, its page and its breadcrumb.
  structure: "Plan",
  proposed: "Proposed",
  happened: "Happened",
  data: "Data",
} as const satisfies Record<LensSection, string>;

/**
 * The sections a lens of this scope kind draws, in order. Which of them OMIT
 * when empty is the section's own empty answer — this only says which can
 * EXIST at the scope.
 */
export function lensSections(
  scopeKind: "pod" | "workspace" | "project" | "track" | "session",
  opts: { ownsData?: boolean } = {}
): LensSection[] {
  return LENS_SECTION_ORDER.filter((s) => {
    if (s === "structure")
      return scopeKind === "project" || scopeKind === "track";
    if (s === "data") return opts.ownsData === true;
    return true;
  });
}

/**
 * At-rest caps (skill §6). Produced is a horizontal row of peers, so it takes
 * more; Proposed is a quiet lane, so it takes fewest; Happened is today's
 * batched lines.
 */
export const LENS_CAPS = {
  blocking: 5,
  happening: 5,
  produced: 8,
  proposed: 3,
  happened: 10,
} as const satisfies Record<AttentionClass, number>;

/**
 * Cap a section by ROWS. `hiddenItems` counts in the rows' own units (a row
 * standing for a session's 3 asks counts 3), so "Show all N" adds up with the
 * header count — the same contract `capNeedsYouRows` keeps for the needs-you
 * page, applied to lens rows of any class.
 */
export function capLensRows<T extends { count?: number }>(
  rows: readonly T[],
  cls: AttentionClass
): { shown: T[]; hiddenRows: number; hiddenItems: number; total: number } {
  const limit = LENS_CAPS[cls];
  const shown = rows.slice(0, limit);
  const hidden = rows.slice(shown.length);
  const units = (r: T) =>
    typeof r.count === "number" && Number.isFinite(r.count) && r.count > 1
      ? Math.floor(r.count)
      : 1;
  return {
    shown,
    hiddenRows: hidden.length,
    hiddenItems: hidden.reduce((n, r) => n + units(r), 0),
    total: rows.reduce((n, r) => n + units(r), 0),
  };
}

// ── Placement ───────────────────────────────────────────────────────────────

/** Which `signals.list` lens a row was read from (plus the lens reads being added). */
export type LensReadLens =
  "needs-you" | "suggestions" | "history" | "happening" | "produced";

/** Where a row lands: one of the five classes, or the one status banner. */
export type LensPlacement = AttentionClass | "banner";

/** The fields of a `Signal` placement reads. */
export interface PlaceableSignal {
  kind: string;
  /** Notification category: governance | data | ai | system | inbox. */
  category?: string | null;
  /** The notification's registry type (`notifications.type`), when the row carries it. */
  notificationType?: string | null;
}

/**
 * THE list of system-HEALTH notification types — the status banner, never a
 * Needs-you row. ONE definition: `placeSignal` reads it here, and the server
 * read (`partitionNotifications`) reaches the same set through the registry's
 * `needsYou: "status"` role, held equal by
 * `api/src/notifications/__tests__/status-banner-parity.test.ts` (the api
 * registry is the typed per-type table; the parity test stops the two drifting).
 * A `system`-CATEGORY type that is NOT here — `workspace.invite`,
 * `system.issuer_pending_approval` — is an ask, hence Blocking.
 */
export const STATUS_BANNER_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  "pod.storage_warning",
  // NOT `system.intelligence_degraded` (P4, 2026-10-06): that is an operator
  // notice now (registry role `informational`, owner + Discord only). What a
  // user sees about AI is `@synap-core/types/ai-availability`'s banner.
]);

/**
 * THE list of WORK-BROKE notification types — an agent or automation run that
 * FAILED. Blocking (a person has to look: the work stopped), but not an ask:
 * the row's mark is `failed`, its verb opens the run ("Open"), and it never
 * wears the "Asked by AI" mark (dogfood 2026-10-05: "meta encountered an
 * error" read as an AI question with no verb). Repeats of one agent's failure
 * fold server-side into ONE row with a count (the registry's `foldBy`).
 * `system.*` health is not here — that is the banner
 * ({@link STATUS_BANNER_NOTIFICATION_TYPES}).
 */
export const FAILURE_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  "agent.task_failed",
  "automation.broken",
]);

/**
 * THE classification rule. Read lens first, then the two exceptions inside
 * the needs-you lens that the approved definition names:
 *
 *   - an agent DRAFT (`draft-asks`) is PROPOSED, not blocking — "drafts never
 *     need you" (`needsYouReason`), and the founder put drafts in Proposed;
 *   - a system-HEALTH notification ({@link STATUS_BANNER_NOTIFICATION_TYPES})
 *     is the status BANNER — health is not a Needs-you row. The CATEGORY alone
 *     is not health: an unknown or untyped system notification is Blocking, the
 *     server's own rule (an unclassifiable type "might still be an ask").
 *
 * Everything else the needs-you lens returns — owed slots, pending proposal
 * clusters (an agent paused on one included), sessions awaiting review,
 * governance / inbox notifications — is BLOCKING.
 */
export function placeSignal(
  signal: PlaceableSignal,
  lens: LensReadLens
): LensPlacement {
  switch (lens) {
    case "needs-you":
      if (signal.kind === "draft-asks") return "proposed";
      if (
        signal.kind === "notification" &&
        signal.notificationType != null &&
        STATUS_BANNER_NOTIFICATION_TYPES.has(signal.notificationType)
      ) {
        return "banner";
      }
      return "blocking";
    case "suggestions":
      return "proposed";
    case "history":
      return "happened";
    case "happening":
      return "happening";
    case "produced":
      return "produced";
  }
}

/**
 * Split a server-ordered needs-you page by placement. A STABLE partition: the
 * server's order (and therefore `needsYouRows`' contiguity rule) survives in
 * each part, so the blocking part can be grouped by `needsYouRows` unchanged.
 */
export function partitionNeedsYou<T extends PlaceableSignal>(
  signals: readonly T[]
): { blocking: T[]; proposed: T[]; banners: T[] } {
  const out = { blocking: [] as T[], proposed: [] as T[], banners: [] as T[] };
  for (const s of signals) {
    const p = placeSignal(s, "needs-you");
    if (p === "banner") out.banners.push(s);
    else if (p === "proposed") out.proposed.push(s);
    else out.blocking.push(s);
  }
  return out;
}

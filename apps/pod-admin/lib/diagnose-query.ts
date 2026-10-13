/**
 * `diagnose.global` runs ~a dozen aggregate reads server-side; it is a health
 * snapshot, not a live feed. Two minutes keeps tab switches free without
 * letting the page drift far from what the pod reports. Every reader — Home,
 * the nav's badges (`useConsoleBadges`), Kinds — passes exactly these options,
 * so they share one cached query instead of racing several.
 */
export const DIAGNOSE_QUERY_OPTIONS = { staleTime: 120_000 } as const;

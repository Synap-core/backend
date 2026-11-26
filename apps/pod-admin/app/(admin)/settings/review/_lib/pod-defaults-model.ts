/**
 * The pod's defaults for every agent, as Settings draws them — "act directly
 * on what can be undone" (`governanceRules.reversibleDefault`), "tidy their
 * own new work" (`governanceRules.ownOrganiseDefault`), the floor families a
 * pod may switch and its governance numbers (`governanceRules.podFloorDefaults`)
 * — and the platform floors under them (`governanceRules.platformDefaults`),
 * said once. Pure: the component only draws what this decides.
 */

/** One dial's read and its last save, as TanStack hands them over. */
export interface DialQuery {
  isLoading: boolean;
  isError: boolean;
  data?: { enabled: boolean; canManage: boolean } | undefined;
}
export interface DialSave {
  isPending: boolean;
  variables?: { enabled: boolean } | undefined;
}

export type DialState =
  | { kind: "loading" }
  /** A failed READ is never a calm "off" switch. */
  | { kind: "failed" }
  | { kind: "ready"; on: boolean; canManage: boolean; saving: boolean };

export function dialState(read: DialQuery, save: DialSave): DialState {
  if (read.isError) return { kind: "failed" };
  if (read.isLoading || !read.data) return { kind: "loading" };
  return {
    kind: "ready",
    // The pick shows while the pod saves it; a refused one falls back.
    on:
      save.isPending && save.variables
        ? save.variables.enabled
        : read.data.enabled,
    canManage: read.data.canManage,
    saving: save.isPending,
  };
}

/** Who may change the defaults: whichever dial answered (one failed read must not hide it). */
export function podDefaultsManageable(
  ...reads: ReadonlyArray<DialQuery>
): boolean | null {
  for (const r of reads) if (r.data) return r.data.canManage;
  return null;
}

/** `governanceRules.podFloorDefaults` as TanStack hands it over. */
export interface FloorsQuery {
  isLoading: boolean;
  isError: boolean;
  data?:
    | {
        families: ReadonlyArray<{ pattern: string; enabled: boolean }>;
        settings: Readonly<Record<string, number>>;
        settingLimits: Readonly<
          Record<string, { default: number; min: number; max: number }>
        >;
        canManage: boolean;
      }
    | undefined;
}

/** One floor family's switch, read from the shared floors read. */
export function floorDial(read: FloorsQuery, pattern: string): DialQuery {
  if (read.isError || read.isLoading || !read.data) {
    return { isLoading: read.isLoading, isError: read.isError };
  }
  const family = read.data.families.find((f) => f.pattern === pattern);
  // A family the pod did not answer for is unread, never a calm "off".
  if (!family) return { isLoading: false, isError: true };
  return {
    isLoading: false,
    isError: false,
    data: { enabled: family.enabled, canManage: read.data.canManage },
  };
}

/** The one floor door's save, as the row of `pattern` sees it. */
export function floorSave(
  save: {
    isPending: boolean;
    variables?: { pattern: string; enabled: boolean } | undefined;
  },
  pattern: string
): DialSave {
  const mine = save.variables?.pattern === pattern;
  return {
    isPending: save.isPending && mine,
    variables: mine ? save.variables : undefined,
  };
}

export type SettingState =
  | { kind: "loading" }
  | { kind: "failed" }
  | {
      kind: "ready";
      value: number;
      min: number;
      max: number;
      canManage: boolean;
    };

/** One governance number setting, read from the shared floors read. */
export function settingState(read: FloorsQuery, key: string): SettingState {
  if (read.isError) return { kind: "failed" };
  if (read.isLoading || !read.data) return { kind: "loading" };
  const value = read.data.settings[key];
  const limits = read.data.settingLimits[key];
  if (value === undefined || !limits) return { kind: "failed" };
  return {
    kind: "ready",
    value,
    min: limits.min,
    max: limits.max,
    canManage: read.data.canManage,
  };
}

/** What was typed, as a value the pod would take (a whole number in range), else null. */
export function parseSetting(
  draft: string,
  limits: { min: number; max: number }
): number | null {
  if (!/^\s*-?\d+\s*$/.test(draft)) return null;
  const value = Number(draft);
  return value >= limits.min && value <= limits.max ? value : null;
}

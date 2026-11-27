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

/** Who may change the defaults: whichever read answered (one failed read must not hide it). */
export function podDefaultsManageable(
  ...reads: ReadonlyArray<{ data?: { canManage: boolean } | undefined }>
): boolean | null {
  for (const r of reads) if (r.data) return r.data.canManage;
  return null;
}

/** One governance number as `governanceRules.podFloorDefaults` lists it. */
export interface PodSetting {
  key: string;
  value: number;
  min: number;
  max: number;
  /** The switch whose rule reads it, drawn under that switch; null = on its own. */
  parameterOf: string | null;
}

/** `governanceRules.podFloorDefaults` as TanStack hands it over. */
export interface FloorsQuery {
  isLoading: boolean;
  isError: boolean;
  data?:
    | {
        families: ReadonlyArray<{ pattern: string; enabled: boolean }>;
        settings: ReadonlyArray<PodSetting>;
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
  const saving = save.isPending && mine;
  return {
    isPending: saving,
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

/** One governance number, read from the shared floors read. */
export function settingState(read: FloorsQuery, key: string): SettingState {
  if (read.isError) return { kind: "failed" };
  if (read.isLoading || !read.data) return { kind: "loading" };
  const setting = read.data.settings.find((s) => s.key === key);
  if (!setting) return { kind: "failed" };
  return {
    kind: "ready",
    value: setting.value,
    min: setting.min,
    max: setting.max,
    canManage: read.data.canManage,
  };
}

/** The settings drawn under `pattern`'s switch, or on their own (`null`). */
export function settingsOf(
  read: FloorsQuery,
  pattern: string | null
): PodSetting[] {
  return (read.data?.settings ?? []).filter((s) => s.parameterOf === pattern);
}

/** The value of the setting `pattern`'s sentence names; null when it was not read. */
export function parameterValue(
  read: FloorsQuery,
  pattern: string
): number | null {
  return settingsOf(read, pattern)[0]?.value ?? null;
}

/**
 * The platform floors that still always ask: an entry a pod switch lifts is
 * left out once that switch is on. While the switches are unread, every
 * floor is listed (the honest reading of an unknown switch).
 */
export function floorsStillAsking<F extends { switchedBy?: string | null }>(
  floors: readonly F[],
  read: FloorsQuery
): F[] {
  const on = new Set(
    (read.data?.families ?? []).filter((f) => f.enabled).map((f) => f.pattern)
  );
  return floors.filter((f) => !f.switchedBy || !on.has(f.switchedBy));
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

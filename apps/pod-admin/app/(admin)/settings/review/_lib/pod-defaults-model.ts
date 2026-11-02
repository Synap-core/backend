/**
 * The pod's two defaults for every agent, as Settings draws them — "act
 * directly on what can be undone" (`governanceRules.reversibleDefault`) and
 * "tidy their own new work" (`governanceRules.ownOrganiseDefault`) — and the
 * platform floors under them (`governanceRules.platformDefaults`), said once.
 * Pure: the component only draws what this decides.
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

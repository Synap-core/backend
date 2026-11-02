/**
 * A dev fact's `data` as a record (`{}` when it is not an object): the ONE
 * reader `pr-state.ts` and `dev-hold.ts` share. Internal: not re-exported from
 * the package root.
 */
export function record(data: unknown): Record<string, unknown> {
  return data && typeof data === "object"
    ? (data as Record<string, unknown>)
    : {};
}

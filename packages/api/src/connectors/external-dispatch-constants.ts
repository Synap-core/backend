/**
 * `events.source` stamped on every external-dispatch audit append (see
 * `recordExternalAction` in `external-dispatch.ts`). Split into its own
 * dependency-free leaf module so a consumer that only needs the constant
 * (e.g. `services/diagnose/resolve-object-kind.ts`'s correlationId fallback)
 * does not have to import the full `external-dispatch.ts` module graph
 * (DB schema, vault resolver, capability gate, permission-check, …) — that
 * heavier import introduced a module-init ordering issue under the vitest
 * SSR transform (a circular-ish import graph made `userVisibleWhere` resolve
 * to `undefined` at diagnose-test time). Both `external-dispatch.ts` and
 * `services/diagnose/*` import THIS constant, never each other.
 */
export const EXTERNAL_DISPATCH_SOURCE = "external-dispatch";

/**
 * wire-parity — this package proves `@synap-core/types` matches it.
 *
 * `@synap-core/types` is the wire: every client (relay, synap-app, browser, the
 * CLI) compiles against it, and it imports nothing from this package (tripwire
 * `packages/api/src/__tripwires__/types-no-database-import.test.ts`). Where the
 * pod's type is inferred from a drizzle table, or backed by a runtime `as const`
 * object, the wire declares the same shape by hand and a file in this folder
 * proves the two EQUAL at compile time: change one side only and `tsc` fails
 * here, naming the contract. Plain shapes (a JSONB column's interface, the
 * automation flow, the workspace definition, an explicit row interface) are not
 * copied at all: they are declared in `@synap-core/types` and imported here.
 *
 * Every export in this folder is a `const _x: Equal<…> = true`: no runtime code.
 */

/**
 * The strict identity check (not mutual assignability): optional vs required,
 * `readonly`, `any` and a widened literal all make it `false`.
 */
export type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/**
 * Spreads an intersection (`Omit<…> & {…}`) into one object type so it can be
 * compared with an interface; keeps every member's modifiers.
 */
export type Flat<T> = { [K in keyof T]: T[K] };

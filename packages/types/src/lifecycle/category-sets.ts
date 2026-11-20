/**
 * Status SETS read off a machine's declaration — THE way a reader names "the
 * statuses of these categories" (a session's open ones, a run's ended ones)
 * without hand-copying the words.
 *
 * Every declared machine (`SESSION_STATUS_DECLARATION`,
 * `RUN_STATUS_DECLARATION`, ...) maps each stored word to one of the five
 * categories. A list written out by hand drifts the day a word is added or
 * re-classified; a set derived here moves with the declaration. A reader that
 * deliberately differs from a category set (leaves one word out on purpose)
 * derives the set and names the exception beside it, never a second literal.
 * `__tripwires__/status-lists-derived.tripwire.test.ts` fails a new hand list.
 *
 * A leaf: its one import is a type, so the dependency-free status leaves
 * (`focus-sessions/statuses.ts`, `units/run-status.ts`) may import it.
 */
import type { LifecycleCategory } from "./option.js";

/** A machine's declaration: each stored status's fixed category. */
export type StatusDeclaration = Readonly<
  Record<string, { readonly category: LifecycleCategory }>
>;

/** The statuses of `D` whose category is one of `C` (a type-level derivation). */
export type StatusOfCategory<
  D extends StatusDeclaration,
  C extends LifecycleCategory,
> = {
  [S in keyof D]: D[S]["category"] extends C ? S : never;
}[keyof D] &
  string;

/**
 * The statuses of `declaration` whose category is one of `categories`, in the
 * declaration's own order.
 */
export function statusesInCategories<
  D extends StatusDeclaration,
  C extends LifecycleCategory,
>(declaration: D, categories: readonly C[]): StatusOfCategory<D, C>[] {
  const wanted = new Set<LifecycleCategory>(categories);
  return Object.keys(declaration).filter((s) =>
    wanted.has(declaration[s]!.category)
  ) as StatusOfCategory<D, C>[];
}

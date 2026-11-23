/**
 * Status sets and categories read off a machine's declaration, so no reader
 * hand-copies status words (`__tripwires__/status-lists-derived.tripwire.test.ts`
 * fails a new hand list). A leaf with one type import: the status leaves may
 * import it.
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

/** The category of `status` in `declaration`; `null` for a value it does not declare. */
export function categoryOf(
  declaration: StatusDeclaration,
  status: string | null | undefined
): LifecycleCategory | null {
  return status != null && Object.hasOwn(declaration, status)
    ? declaration[status]!.category
    : null;
}

/** A machine's transition table: from → the statuses it may move to. */
export type StatusTransitions<S extends string> = {
  readonly [K in S]: readonly S[];
};

/** May a row in `from` move to `to` under `table`? A move not listed is never written. */
export function canTransition<S extends string>(
  table: StatusTransitions<S>,
  from: S,
  to: S
): boolean {
  return table[from]?.includes(to) ?? false;
}

/** Every status `table` lets reach `to`. */
export function statusesThatMayBecome<S extends string>(
  table: StatusTransitions<S>,
  to: S
): S[] {
  return (Object.keys(table) as S[]).filter((from) =>
    canTransition(table, from, to)
  );
}

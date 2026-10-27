/**
 * A graph proposal's records, one group per kind, each capped — pure, so the
 * rule is tested apart from the markup.
 *
 * Live (a capture of 106 records): one uncapped column 34,545 px tall, the
 * decision at its very bottom. A list is capped, then "Show all N"
 * (ui-composition §4). Never capped: what acts on its own (a skill, an
 * automation, a rule, an update to one) and a record still owing a choice (its
 * twin): nobody approves what they cannot see, nor sends a choice they did not
 * make.
 */

/** Records of one kind drawn before "Show all N". */
export const RECORDS_SHOWN_PER_KIND = 5;

export interface RecordGroup<T> {
  /** The records' kind (a profile slug or object kind), null when unknown. */
  kind: string | null;
  /** Every record of the kind, in reading order. */
  all: T[];
  /** The ones drawn before "Show all". */
  shown: T[];
}

/**
 * Group by kind (in order of first appearance), keeping the reading order
 * inside a group, and cap each group: the first `cap` records that may fold,
 * plus every one that may not.
 */
export function recordGroups<T extends { kind: string | null }>(
  records: readonly T[],
  neverFolded: (record: T) => boolean,
  cap: number = RECORDS_SHOWN_PER_KIND
): RecordGroup<T>[] {
  const byKind = new Map<string | null, T[]>();
  for (const record of records) {
    const group = byKind.get(record.kind);
    if (group) group.push(record);
    else byKind.set(record.kind, [record]);
  }
  return [...byKind].map(([kind, all]) => {
    let foldable = 0;
    const shown = all.filter((record) => {
      if (neverFolded(record)) return true;
      foldable += 1;
      return foldable <= cap;
    });
    return { kind, all, shown };
  });
}

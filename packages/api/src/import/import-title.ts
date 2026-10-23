/**
 * The title of an import proposal: what approving it CREATES, counted by kind,
 * and where it came from —
 *
 *   "Import 1,489 people, 1,338 companies and 1,462 links from Connections.csv"
 *
 * MEASURED DEFECT (live, 2026-10-22, proposal 0728053b): a 2,827-entity
 * contacts import was titled "csv import: _Julien SIÉ, -, +2825 more · Quality
 * 70/100 — looks solid for apply after human review." The reviewer was shown
 * the first two row titles and a quality score, never the size of the change.
 * The quality line belongs in the body (`data.quality`), not in the title.
 *
 * Every word that names a domain value comes from the vocabulary door: the
 * verb (`resolveActionLabel("import")`), each kind's noun and curated plural
 * (`resolveObjectNoun` / `resolveObjectNounPlural`, so "people", never
 * "persons"), and the mid-sentence casing (`nounInSentence`). Nothing here is
 * a label map. The counts are formatted with an `en-US` grouping (the product
 * is English-only; `.claude/rules/vocabulary.md` "Why not i18n").
 *
 * Pure: imports only the vocabulary, so a test loads it with no database.
 */

import {
  nounInSentence,
  pluralizeNoun,
  resolveActionLabel,
  resolveObjectNoun,
  resolveObjectNounPlural,
} from "@synap-core/types/vocabulary";

/** The subset of a composite operation this reads. */
export interface ImportTitleOperation {
  op?: unknown;
  profileSlug?: unknown;
  existingEntityId?: unknown;
}

/** Kinds named in the title before the rest fold into "N other items". */
const NAMED_KINDS_MAX = 3;

const COUNT = new Intl.NumberFormat("en-US");

/** The kind an operation creates, or null when it creates nothing new. */
function createdKind(op: ImportTitleOperation): string | null {
  const name = typeof op.op === "string" ? op.op : "";
  if (name === "create_entity") {
    // An op that LINKS an entity the pod already holds creates nothing.
    if (typeof op.existingEntityId === "string" && op.existingEntityId) {
      return null;
    }
    return typeof op.profileSlug === "string" && op.profileSlug
      ? op.profileSlug
      : "entity";
  }
  // A graph edge (`create_relation`) and a links-table edge (`create_link`)
  // are both a "link" to the person.
  if (name === "create_relation" || name === "create_link") return "relation";
  if (name.startsWith("create_")) return name.slice("create_".length);
  return null;
}

function countedKind(n: number, kind: string): string {
  const noun =
    n === 1 ? resolveObjectNoun(kind) : resolveObjectNounPlural(kind);
  return `${COUNT.format(n)} ${nounInSentence(noun)}`;
}

function countedNoun(n: number, noun: string): string {
  return `${COUNT.format(n)} ${n === 1 ? noun : pluralizeNoun(noun)}`;
}

/** "a", "a and b", "a, b and c". */
function joinParts(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** "Connections.csv" for one file, "3 files" for several, "" for none. */
function sourceLabel(itemPaths: ReadonlyArray<string>): string {
  const paths = itemPaths.filter((p) => p.trim());
  if (paths.length === 0) return "";
  if (paths.length === 1) {
    const segments = paths[0]!.split(/[\\/]/).filter(Boolean);
    return segments[segments.length - 1] ?? paths[0]!;
  }
  return countedNoun(paths.length, "file");
}

/**
 * Title an import graph by what it creates. Kinds are ordered by count (ties
 * keep the plan's order), links come last, and past {@link NAMED_KINDS_MAX}
 * kinds the remainder is folded into "N other items" — counted, never hidden.
 */
export function buildImportTitle(
  operations: ReadonlyArray<ImportTitleOperation>,
  itemPaths: ReadonlyArray<string> = [],
  /** How many of the linked entities were matched on their NAME alone. */
  opts: { matchedByName?: number } = {}
): string {
  const byKind = new Map<string, number>();
  let links = 0;
  // Rows that LINK an entity the pod already holds: said, not hidden — the
  // reviewer learns the import touches existing records.
  const existing = operations.filter(
    (op) =>
      op.op === "create_entity" &&
      typeof op.existingEntityId === "string" &&
      op.existingEntityId !== ""
  ).length;
  for (const op of operations) {
    const kind = createdKind(op);
    if (!kind) continue;
    if (kind === "relation") links++;
    else byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
  }

  const kinds = [...byKind.entries()].sort((a, b) => b[1] - a[1]);
  const named = kinds.slice(0, NAMED_KINDS_MAX);
  const rest = kinds.slice(NAMED_KINDS_MAX).reduce((sum, [, n]) => sum + n, 0);

  const parts = named.map(([kind, n]) => countedKind(n, kind));
  if (rest > 0) parts.push(countedNoun(rest, "other item"));
  if (links > 0) parts.push(countedKind(links, "relation"));

  const source = sourceLabel(itemPaths);
  const byName = opts.matchedByName ?? 0;
  const linking =
    existing > 0
      ? `, linking ${COUNT.format(existing)} already in your pod` +
        (byName > 0 ? ` (${COUNT.format(byName)} matched by name only)` : "")
      : "";
  return (
    [
      resolveActionLabel("import", "imperative"),
      joinParts(parts),
      source ? `from ${source}` : "",
    ]
      .filter(Boolean)
      .join(" ") + linking
  );
}

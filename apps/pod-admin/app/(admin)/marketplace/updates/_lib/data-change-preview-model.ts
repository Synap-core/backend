/**
 * The words of one data change's before → after block (finding 4e4b2858),
 * from the pod's preview (`PackageDataChange.preview`). Every name is the
 * pod's label (a kind's display name, a field's label, a status's label); the
 * sentences around them are this folder's catalogs. Pure: the page draws it,
 * the test reads it.
 */

import type { TFunction } from "@synap-core/types/i18n";
import type { DataChangePreview, DataChangeSide } from "./contract";
import type { en } from "./copy";

type T = TFunction<typeof en>;

/** A capped list: the titles shown, and the "and N more" after them. */
export interface PreviewList {
  titles: string[];
  more: string | null;
}

export interface PreviewBox {
  kind: string;
  detail: string | null;
  count: number;
}

export interface PreviewWords {
  title: string;
  scope: string;
  from: PreviewBox;
  to: PreviewBox;
  /** One reassurance line, or each old value → new value (translate). */
  notes: string[];
  see: string;
  list: PreviewList;
  kept: {
    title: string;
    count: number;
    groups: Array<{
      reason: string;
      count: number;
      see: string;
      list: PreviewList;
    }>;
  } | null;
}

function box(t: T, side: DataChangeSide): PreviewBox {
  const detail = side.detail
    ? side.detail.as === "field"
      ? t("preview.field", { field: side.detail.label.label })
      : side.detail.label.label
    : null;
  return { kind: side.kind.label, detail, count: side.count };
}

function list(t: T, titles: string[], more: number): PreviewList {
  return {
    titles,
    more: more > 0 ? t("preview.more", { n: more }) : null,
  };
}

function title(t: T, p: DataChangePreview): string {
  switch (p.change) {
    case "rekind":
      return t("preview.title.rekind", {
        from: p.from.kind.plural,
        status: p.from.detail?.label.label ?? "",
        to: p.to.kind.plural,
      });
    case "renameField":
      return t("preview.title.renameField", { kinds: p.from.kind.plural });
    case "renameKind":
      return t("preview.title.renameKind", {
        from: p.from.kind.label,
        to: p.to.kind.label,
      });
    case "translateValues":
      return t("preview.title.translateValues", {
        field: p.from.detail?.label.label ?? "",
        kinds: p.from.kind.plural,
      });
  }
}

function notes(t: T, p: DataChangePreview): string[] {
  switch (p.change) {
    case "rekind":
    case "renameKind":
      return [t("preview.note.sameRecords")];
    case "renameField":
      return [t("preview.note.valuesMove")];
    case "translateValues":
      return (p.values ?? []).map((v) =>
        t("preview.note.value", {
          from: v.from.label,
          to: v.to.label,
          n: v.count,
        })
      );
  }
}

/**
 * The block's words. `andList` joins field names in the reader's language
 * ("Publish date, Series and Campaign": `Intl.ListFormat` on the page).
 */
export function previewWords(
  t: T,
  p: DataChangePreview,
  andList: (words: string[]) => string
): PreviewWords {
  const looked = p.from.count + (p.kept?.count ?? 0);
  return {
    title: title(t, p),
    scope: t("preview.scope", {
      n: looked,
      kind: p.from.kind.label,
      kinds: p.from.kind.plural,
    }),
    from: box(t, p.from),
    to: box(t, p.to),
    notes: notes(t, p),
    see: t("preview.see", {
      n: p.to.count,
      kind: p.to.kind.label,
      kinds: p.to.kind.plural,
    }),
    list: list(t, p.samples.titles, p.samples.more),
    kept: p.kept
      ? {
          title: t("preview.kept.title", { kinds: p.from.kind.plural }),
          count: p.kept.count,
          groups: p.kept.groups.map((g) => ({
            reason: t("preview.kept.fieldsSet", {
              fields: andList(g.fields.map((f) => f.label)),
            }),
            count: g.count,
            see: t("preview.kept.see", { n: g.count }),
            list: list(t, g.samples.titles, g.samples.more),
          })),
        }
      : null,
  };
}

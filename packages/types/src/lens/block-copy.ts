/**
 * The words of a document's blocks that every client draws the same, as
 * catalogs (`@synap-core/types/i18n`): English is the source and the type,
 * French translates it ("vous").
 *
 *   lens.empty.*     a lens section with nothing in it: its title, and the
 *                    WHY an EXPLAIN answer owes (ui-composition §2). Before
 *                    this file the English lived in the web lens page
 *                    (`LENS_EMPTY_TITLES`, `LENS_EMPTY_WHY`, synap-app
 *                    `packages/web/src/lens-page/copy.ts`) and the phone
 *                    mirrored it (`relay.workCell.empty.*`, `.why.*`), pinned
 *                    by a tripwire that parsed web's file by path. The French
 *                    is the phone's.
 *   block.placeholder.*  the ONE placeholder of a block a client cannot draw
 *                    ({@link BLOCK_PLACEHOLDER_STATES}, `./block-placeholder`).
 *
 * DRAFT French, awaiting the founder's review with the vocabulary's.
 */
import { ambientCatalogLocale } from "../i18n/ambient.js";
import { createT, type Catalog, type Locale } from "../i18n/index.js";
import type { AttentionClass } from "./sections.js";

export const en = {
  /** A lens section's title when it has nothing in it (never shown for `omit`). Needs you's is the page's "All clear". */
  "lens.empty.title.blocking": "All clear",
  "lens.empty.title.happening": "Nothing in progress",
  "lens.empty.title.produced": "Nothing produced yet",
  "lens.empty.title.proposed": "No suggestions",
  "lens.empty.title.happened": "Nothing happened yet",
  /** What fills a lens section: the WHY an EXPLAIN empty answer owes. */
  "lens.empty.why.blocking":
    "Decisions and answers that agents wait on land here.",
  "lens.empty.why.happening":
    "Sessions an agent is running here appear while they run.",
  "lens.empty.why.produced":
    "What the work here makes lands here as it is made.",
  "lens.empty.why.proposed": "The AI's suggestions and drafts land here.",
  "lens.empty.why.happened": "Every change made here is listed by day.",

  /** This client has no way to draw this kind of block (a frame the phone does not run, a widget it lacks). */
  "block.placeholder.unsupported.title": "Can’t show this block here",
  /** The reader may not read what the block shows. No retry: trying again changes nothing. */
  "block.placeholder.noAccess.title": "This block isn’t shared with you",
  /** The block's read failed: retryable, never "nothing here". */
  "block.placeholder.failed.title": "Couldn’t load this block",
  /** The door of an unsupported block: open the thing where it can be drawn. */
  "block.placeholder.open": "Open in app",
  /** The act of a failed block. */
  "block.placeholder.retry": "Try again",
} as const;

export const fr: Catalog<typeof en> = {
  "lens.empty.title.blocking": "Rien ne vous attend",
  "lens.empty.title.happening": "Rien en cours",
  "lens.empty.title.produced": "Rien de produit pour l’instant",
  "lens.empty.title.proposed": "Aucune suggestion",
  "lens.empty.title.happened": "Rien ne s’est encore passé",
  "lens.empty.why.blocking":
    "Les décisions et les réponses qu’attendent les agents arrivent ici.",
  "lens.empty.why.happening":
    "Les sessions qu’un agent mène ici apparaissent pendant qu’elles tournent.",
  "lens.empty.why.produced":
    "Ce que le travail produit ici arrive ici, au fur et à mesure.",
  "lens.empty.why.proposed":
    "Les suggestions et les brouillons de l’IA arrivent ici.",
  "lens.empty.why.happened": "Chaque changement fait ici est listé par jour.",

  "block.placeholder.unsupported.title": "Impossible d’afficher ce bloc ici",
  "block.placeholder.noAccess.title": "Ce bloc n’est pas partagé avec vous",
  "block.placeholder.failed.title": "Impossible de charger ce bloc",
  "block.placeholder.open": "Ouvrir dans l’app",
  "block.placeholder.retry": "Réessayer",
};

/** The key of each attention class's empty title: a new class without its words fails the build. */
export const LENS_EMPTY_TITLE_KEY = {
  blocking: "lens.empty.title.blocking",
  happening: "lens.empty.title.happening",
  produced: "lens.empty.title.produced",
  proposed: "lens.empty.title.proposed",
  happened: "lens.empty.title.happened",
} as const satisfies Record<AttentionClass, keyof typeof en>;

/** The key of each attention class's empty WHY. */
export const LENS_EMPTY_WHY_KEY = {
  blocking: "lens.empty.why.blocking",
  happening: "lens.empty.why.happening",
  produced: "lens.empty.why.produced",
  proposed: "lens.empty.why.proposed",
  happened: "lens.empty.why.happened",
} as const satisfies Record<AttentionClass, keyof typeof en>;

/** The block words' catalogs, for a surface that composes its own translator (`useT`). */
export const lensBlockCopy = { en, fr } as const;

/** The block words' translator, in `locale` (else the ambient catalog locale). */
export function lensBlockT(locale?: Locale) {
  return createT(locale ?? ambientCatalogLocale(), lensBlockCopy);
}

/** An empty lens section's title. */
export function lensEmptyTitle(
  section: AttentionClass,
  locale?: Locale
): string {
  return lensBlockT(locale)(LENS_EMPTY_TITLE_KEY[section]);
}

/** What fills a lens section: the WHY an EXPLAIN empty answer owes. */
export function lensEmptyWhy(section: AttentionClass, locale?: Locale): string {
  return lensBlockT(locale)(LENS_EMPTY_WHY_KEY[section]);
}

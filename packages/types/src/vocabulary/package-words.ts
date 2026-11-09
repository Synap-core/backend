/**
 * What a package is called, and the permission that installs one, in people's
 * words (founder, 2026-11-05): a TEMPLATE is one object (a capability, a
 * playbook, a cell, a kind, an automation); a PACK is several (a space with
 * its kinds and views, a set of workflows). The noun is DERIVED from what the
 * package holds, never declared by its author, and every surface that names a
 * package it knows (the install preview, the proposal card, the install
 * result) reads it here.
 */

import type { Locale } from "../i18n/locale.js";
import type { VocabularySentencesEn } from "./catalog.en.js";
import { catalogLocaleOf, sentences } from "./translate.js";

/**
 * "Template" for a package of ONE object, "Pack" for several. `objectCount`
 * is how many objects installing it adds (spaces, kinds, views, playbooks,
 * automations, capabilities, ...); 0 or 1 reads as a template.
 */
export function resolvePackageNoun(
  objectCount: number,
  opts: { plural?: boolean; locale?: Locale } = {}
): string {
  const t = sentences(catalogLocaleOf(opts.locale));
  if (objectCount > 1)
    return t(
      opts.plural
        ? "vocabulary.packageNoun.pack.other"
        : "vocabulary.packageNoun.pack.one"
    );
  return t(
    opts.plural
      ? "vocabulary.packageNoun.template.other"
      : "vocabulary.packageNoun.template.one"
  );
}

/** Permissions read as their act (a sentence), keyed by their grant pattern. */
const GRANT_PERMISSION_SENTENCES: Readonly<
  Record<string, keyof VocabularySentencesEn>
> = {
  // L7 "Add to my pod": an app asks to install packages into the person's pod.
  "package.install": "vocabulary.grant.packageInstall",
};

/**
 * The sentence a permission is read as, when it has one: `package.install` is
 * "Add packs and templates to your pod", never "Install Packages". Null for
 * every other permission (it is worded from its subject and verb).
 */
export function resolveGrantPermissionSentence(
  permission: string,
  opts: { locale?: Locale } = {}
): string | null {
  const key = GRANT_PERMISSION_SENTENCES[permission];
  return key ? sentences(catalogLocaleOf(opts.locale))(key) : null;
}

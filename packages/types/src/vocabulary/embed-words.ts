/**
 * The words for a document embed — the vocabulary half of the shared embed
 * model (`describeEmbed`, `@synap-core/types/renderables`, which carries only
 * facts). Every surface that names an embed (the web console, relay, the
 * desktop) asks here, so "Card", "Kanban view" and "Weekly pulse" read the
 * same everywhere and no surface keeps its own noun table.
 *
 *   noun   what kind of thing it is ("Chart", "Entity", "View", "Card")
 *   label  what it is called: the authored label, else the catalog's name,
 *          else the humanized key or type, else the noun — never blank
 */

import type { EmbedModel } from "../renderables/embed-model.js";
import { humanizeToken, nounInSentence, resolveObjectNoun } from "./index.js";

export interface EmbedWords {
  noun: string;
  label: string;
}

/** The object kind whose noun names this embed. */
function nounKind(model: EmbedModel): string {
  switch (model.kind) {
    case "chart-snapshot":
    case "chart-broken":
    case "chart-live":
      return "chart";
    case "entity":
    case "view":
      return model.kind;
    case "cell-frame":
    case "cell-builtin":
      return "cell";
    case "broken":
    case "unknown":
      return model.directiveKind;
  }
}

export function resolveEmbedWords(model: EmbedModel): EmbedWords {
  const noun = resolveObjectNoun(nounKind(model));
  switch (model.kind) {
    case "chart-snapshot":
    case "chart-broken":
    case "chart-live":
      return { noun, label: model.label ?? humanizeToken(model.cellKey) };
    case "view":
      return {
        noun,
        label:
          model.label ??
          (model.viewType
            ? `${humanizeToken(model.viewType)} ${nounInSentence(noun)}`
            : noun),
      };
    case "cell-frame":
      return {
        noun,
        label:
          model.label ?? (model.keyName ? humanizeToken(model.keyName) : noun),
      };
    case "cell-builtin":
      return { noun, label: model.label };
    case "unknown":
      return {
        noun,
        label:
          model.label ?? (model.cellKey ? humanizeToken(model.cellKey) : noun),
      };
    case "entity":
      return { noun, label: model.label ?? noun };
    case "broken":
      return { noun, label: noun };
  }
}

/**
 * The vocabulary as a catalog (plan 915cc937 stage P2a): the English catalog
 * is derived from the tables, French translates every key, the resolvers
 * answer in the locale they are given (else the ambient one), and French
 * agrees with the noun it names.
 */
import { afterEach, describe, expect, it } from "vitest";
import { setAmbientCatalogLocale } from "../i18n/ambient.js";
import { catalogProblems } from "../i18n/translator.js";
import {
  ACTION_VERBS,
  NEEDS_YOU_ITEM_NOUNS,
  OBJECT_KINDS,
  OBJECT_NOUNS,
  STATUS_LABELS,
  buildActionLabel,
  buildObjectActionTitle,
  nounParams,
  resolveActionLabel,
  resolveActionPresent,
  resolveActionProgressive,
  resolveHandedToLabel,
  resolveMembersDecideLabel,
  resolveNeedsYouItemCount,
  resolveNextRungOfferLabel,
  resolveNoun,
  resolveObjectIdentity,
  resolveObjectNoun,
  resolveObjectNounPlural,
  resolvePrivateObjectLabel,
  resolveStatusLabel,
  resolveTemplateNoun,
  vocabularyCatalogs,
  vocabularyEn,
} from "./index.js";
import { vocabularyFrNouns } from "./catalog.fr.js";

afterEach(() => setAmbientCatalogLocale("en"));

const NBSP = " ";
const quoted = (name: string) => `«${NBSP}${name}${NBSP}»`;

describe("the catalogs", () => {
  it("are sound: French holds every English key, in the subset, reading the same arguments", () => {
    expect(catalogProblems(vocabularyCatalogs)).toEqual([]);
  });

  it("derive English from every table row (non-vacuity)", () => {
    const keys = Object.keys(vocabularyEn);
    expect(keys.length).toBeGreaterThan(500);
    for (const slug of Object.keys(OBJECT_KINDS)) {
      expect(keys).toContain(`kind.${slug}.one`);
      expect(keys).toContain(`kind.${slug}.other`);
    }
    for (const slug of Object.keys(OBJECT_NOUNS)) {
      expect(keys).toContain(`kind.${slug}.other`);
    }
    for (const [token, verb] of Object.entries(ACTION_VERBS)) {
      expect(
        vocabularyEn[`action.${token}.past` as keyof typeof vocabularyEn]
      ).toBe(verb.past);
    }
    for (const [token, label] of Object.entries(STATUS_LABELS)) {
      expect(vocabularyEn[`status.${token}` as keyof typeof vocabularyEn]).toBe(
        label
      );
    }
    for (const kind of Object.keys(NEEDS_YOU_ITEM_NOUNS)) {
      expect(keys).toContain(`needsYou.count.${kind}`);
    }
  });

  it("give every noun of the catalog its French grammar", () => {
    const slugs = Object.keys(vocabularyEn)
      .filter((k) => k.startsWith("kind.") && k.endsWith(".one"))
      .map((k) => k.slice("kind.".length, -".one".length));
    expect(slugs.length).toBeGreaterThan(60);
    expect(Object.keys(vocabularyFrNouns).sort()).toEqual(slugs.sort());
  });
});

describe("English is unchanged: no locale, the ambient default and an explicit en agree", () => {
  it("for every curated token of every resolver", () => {
    for (const token of Object.keys(ACTION_VERBS)) {
      for (const mood of ["imperative", "past"] as const) {
        expect(resolveActionLabel(token, mood, "en")).toBe(
          resolveActionLabel(token, mood)
        );
      }
    }
    for (const status of Object.keys(STATUS_LABELS)) {
      expect(resolveStatusLabel(status, "en")).toBe(STATUS_LABELS[status]);
    }
    for (const kind of [
      ...Object.keys(OBJECT_KINDS),
      ...Object.keys(OBJECT_NOUNS),
    ]) {
      expect(resolveObjectNoun(kind)).toBe(resolveObjectNoun(kind, "en"));
    }
  });

  it("titles, buttons and counts read as before", () => {
    expect(
      buildObjectActionTitle({
        action: "create",
        objectKind: "task",
        objectName: "Brief",
      })
    ).toBe('Create Task "Brief"');
    expect(
      buildObjectActionTitle({
        action: "section_update",
        objectKind: "document",
        objectName: "Plan",
      })
    ).toBe('Edit section in Document "Plan"');
    expect(
      buildActionLabel({ action: "create", objectKind: "ui-design" })
    ).toBe("Create UI design");
    expect(resolveNeedsYouItemCount("decision", 0)).toBe("0 decisions");
    expect(resolveNeedsYouItemCount("decision", 1)).toBe("1 decision");
    expect(resolveNeedsYouItemCount("mystery_kind", 2)).toBe("2 mystery kinds");
    expect(resolveObjectNounPlural("api_key")).toBe("API keys");
  });

  it("the English bundle says when a noun takes 'an'", () => {
    expect(nounParams(resolveNoun("task", "en"))).toEqual({
      obj: "task",
      Obj: "Task",
      objs: "tasks",
      objG: "n",
      objV: "no",
    });
    expect(nounParams(resolveNoun("idea", "en")).objV).toBe("yes");
    expect(nounParams(resolveNoun("ui-design", "en")).obj).toBe("UI design");
  });
});

describe("French: words", () => {
  it("nouns, plurals and their grammar", () => {
    expect(resolveObjectNoun("task", "fr")).toBe("Tâche");
    expect(resolveObjectNounPlural("person", "fr")).toBe("Personnes");
    expect(resolveObjectNoun("focus_session", "fr")).toBe("Session");
    expect(resolveObjectNounPlural("channel", "fr")).toBe("Canaux");
    expect(resolveNoun("idea", "fr")).toEqual({
      one: "Idée",
      other: "Idées",
      gender: "f",
      elides: true,
    });
    expect(resolveNoun("project", "fr").gender).toBe("m");
  });

  it("a kind no catalog names keeps its words and the neutral gender", () => {
    expect(resolveNoun("recipe", "fr")).toEqual({
      one: "Recipe",
      other: "Recipes",
      gender: "n",
      elides: false,
    });
  });

  it("verbs in each mood, statuses", () => {
    expect(resolveActionLabel("create", "imperative", "fr")).toBe("Créer");
    expect(resolveActionLabel("entity.create", "past", "fr")).toBe("Créé");
    expect(resolveActionProgressive("reject", "fr")).toBe("Rejet en cours");
    expect(resolveActionPresent("update", "fr")).toBe("Met à jour");
    // No curated present: the imperative, in French.
    expect(resolveActionPresent("delete", "fr")).toBe("Supprimer");
    expect(resolveStatusLabel("pending", "fr")).toBe("En attente");
    // An uncurated token keeps the English fallback, never a raw token.
    expect(resolveActionLabel("declare_source", "past", "fr")).toBe(
      "Declare source"
    );
  });

  it("the registry's identity label, a profile's own label still wins", () => {
    expect(resolveObjectIdentity("task", null, null, "fr").label).toBe("Tâche");
    expect(resolveObjectIdentity("task", null, null, "fr").labelPlural).toBe(
      "Tâches"
    );
    expect(
      resolveObjectIdentity("task", { label: "Todo" }, null, "fr").label
    ).toBe("Todo");
  });

  it("template nouns", () => {
    expect(resolveTemplateNoun("project", { locale: "fr" })).toBe(
      "Modèle d’objectif"
    );
    expect(resolveTemplateNoun(null, { plural: true, locale: "fr" })).toBe(
      "Modèles de travail"
    );
  });
});

describe("French: sentences agree with the noun", () => {
  const title = (
    action: string,
    objectKind: string | null,
    objectName?: string,
    mood?: "imperative" | "past"
  ) =>
    buildObjectActionTitle({
      action,
      objectKind,
      objectName,
      mood,
      locale: "fr",
    });

  it("a title takes the noun's article", () => {
    expect(title("create", "task", "Brief")).toBe(
      `Créer la tâche ${quoted("Brief")}`
    );
    expect(title("create", "project", "Site")).toBe(
      `Créer le projet ${quoted("Site")}`
    );
    expect(title("create", "idea", "Pivot")).toBe(
      `Créer l’idée ${quoted("Pivot")}`
    );
    expect(title("delete", "workspace")).toBe("Supprimer l’espace");
  });

  it("a kind a person defined takes the neutral frame", () => {
    expect(title("create", "recipe", "Pâtes")).toBe(
      `Créer l’élément Recipe ${quoted("Pâtes")}`
    );
  });

  it("a past title names the act first: a participle alone is masculine (D4)", () => {
    expect(title("create", "task", "Brief", "past")).toBe(
      `Créé${NBSP}: tâche ${quoted("Brief")}`
    );
  });

  it("a preposition contracts with the article", () => {
    expect(title("section_update", "document", "Plan")).toBe(
      `Modifier la section dans le document ${quoted("Plan")}`
    );
    expect(title("session_narrative_update", "project")).toBe(
      "Mettre à jour le récit du projet"
    );
    expect(title("session_narrative_update", "session")).toBe(
      "Mettre à jour le récit de la session"
    );
    expect(title("widen_scopes", "issuer")).toBe(
      "Élargir l’accès pour l’émetteur de confiance"
    );
  });

  it("a lead, a bare verb, a missing verb", () => {
    expect(title("held_writes", null, "Claude Code, 2026-10-27")).toBe(
      `Écritures en attente de revue${NBSP}: Claude Code, 2026-10-27`
    );
    expect(title("run", null, "Sync")).toBe(`Exécuter ${quoted("Sync")}`);
    expect(buildObjectActionTitle({ objectKind: "task", locale: "fr" })).toBe(
      `Proposition${NBSP}: tâche`
    );
  });

  it("a button takes the indefinite article", () => {
    expect(
      buildActionLabel({ action: "create", objectKind: "task", locale: "fr" })
    ).toBe("Créer une tâche");
    expect(
      buildActionLabel({
        action: "create",
        objectKind: "project",
        locale: "fr",
      })
    ).toBe("Créer un projet");
    expect(
      buildActionLabel({
        action: "create",
        objectKind: "recipe",
        locale: "fr",
      })
    ).toBe("Créer un élément Recipe");
  });

  it("private and members-decide marks agree", () => {
    expect(resolvePrivateObjectLabel("focus_session", "fr")).toBe(
      "Session privée"
    );
    expect(resolvePrivateObjectLabel("project", "fr")).toBe("Projet privé");
    expect(resolvePrivateObjectLabel("recipe", "fr")).toBe(
      `Élément privé${NBSP}: recipe`
    );
    expect(resolvePrivateObjectLabel(undefined, "fr")).toBe("Élément privé");
    expect(resolveMembersDecideLabel("focus_session", "fr")).toBe(
      "Les membres de la session décident"
    );
    expect(resolveMembersDecideLabel("project", "fr")).toBe(
      "Les membres du projet décident"
    );
    expect(resolveMembersDecideLabel("workspace", "fr")).toBe(
      "Les membres de l’espace décident"
    );
  });

  it("counts follow French plural rules: 0 and 1 are singular, millions take 'de'", () => {
    expect(resolveNeedsYouItemCount("decision", 0, "fr")).toBe("0 décision");
    expect(resolveNeedsYouItemCount("decision", 1, "fr")).toBe("1 décision");
    expect(resolveNeedsYouItemCount("decision", 2, "fr")).toBe("2 décisions");
    expect(resolveNeedsYouItemCount("physical", 1_000_000, "fr")).toBe(
      "1000000 d’actions"
    );
  });

  it("hand-offs and offers", () => {
    expect(resolveHandedToLabel("growth_scout", null, "fr")).toBe(
      "Confié à Growth scout"
    );
    expect(resolveNextRungOfferLabel("quiet", "pod", "fr")).toBe(
      "Always let it do this dans tous les espaces"
    );
  });
});

describe("the ambient catalog locale", () => {
  it("is what a resolver with no locale answers in", () => {
    expect(resolveObjectNoun("task")).toBe("Task");
    setAmbientCatalogLocale("fr");
    expect(resolveObjectNoun("task")).toBe("Tâche");
    expect(resolveStatusLabel("pending")).toBe("En attente");
    expect(buildActionLabel({ action: "create", objectKind: "task" })).toBe(
      "Créer une tâche"
    );
    // An explicit locale wins over it.
    expect(resolveObjectNoun("task", "en")).toBe("Task");
  });
});

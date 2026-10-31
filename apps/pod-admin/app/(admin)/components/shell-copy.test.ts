import { describe, expect, it } from "vitest";
import { catalogProblems, createT } from "@synap-core/types/i18n";
import { resolveObjectNounPlural } from "@synap-core/types/vocabulary";
import { CLIENT_NAV, navItem } from "../../../lib/console-nav";
import { en, fr } from "./copy";

describe("the shell's catalogs", () => {
  it("translates every English key, with the same arguments", () => {
    expect(catalogProblems({ en, fr })).toEqual([]);
  });

  it("names each client place in English exactly as the nav table does", () => {
    // One English word per place: the table is what the palette, Home and
    // the redirects read, the catalog what the nav draws.
    for (const id of CLIENT_NAV) {
      const item = navItem(id);
      const english = item.kind
        ? resolveObjectNounPlural(item.kind, "en")
        : en[`nav.${id}` as keyof typeof en];
      expect(english, id).toBe(item.label);
    }
  });

  it("says the client's words in French (audit 110dd4ab G1)", () => {
    const t = createT("fr", { en, fr });
    expect(
      ["home", "review", "history", "members", "settings"].map((id) =>
        t(`nav.${id}` as "nav.home")
      )
    ).toEqual(["Accueil", "Demandes", "Historique", "Équipe", "Réglages"]);
  });
});

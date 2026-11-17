/**
 * THE VERB FOLLOWS THE OBJECT (one UX across surfaces, D3; finding 558257f1:
 * a bar said "Reject" over "If you refuse"). A proposal is rejected, an ask
 * refused, each from the vocabulary door; the button, the sheet, the
 * consequence line, the receipt and the decided outcome of ONE object share
 * its verb and never say the other one.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createT, type Locale } from "@synap-core/types/i18n";
import { resolveActionLabel } from "@synap-core/types/vocabulary";
import { askCopy } from "@synap-core/types/ask";
import {
  RefuseSheet,
  RefuseTrigger,
  refuseVerb,
  type RefuseKind,
} from "../../_lib/request/refuse-sheet";
import { REQUEST_CATALOGS } from "../../_lib/request/copy";
import * as receipt from "../../_lib/receipt/copy";
import * as page from "./copy";

const LOCALES = ["en", "fr"] as const satisfies readonly Locale[];

/** A verb's stem in a locale ("rejec" / "rejet", "refus"): what each form of it shares. */
const stem = (verb: "refuse" | "reject", locale: Locale) =>
  resolveActionLabel(verb, "imperative", locale).slice(0, 5).toLowerCase();

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Every word one object's turn-down says, in `locale`. */
function wordsOf(kind: RefuseKind, locale: Locale): string[] {
  const t = createT(locale, REQUEST_CATALOGS);
  const verb = refuseVerb(kind);
  const sheet = [t("refuse.confirm", { verb }), t("refuse.reassure", { verb })];
  if (kind === "proposal") {
    const receipts = receipt[locale];
    const pageWords = page[locale];
    const always = locale === "en" ? page.alwaysEn : page.alwaysFr;
    return [
      ...sheet,
      t("refuse.proposalConsequence", { who: "Claude Code" }),
      t("refuse.proposalConsequenceAnyone"),
      receipts["reject.applied"],
      receipts["reject.failed"],
      pageWords["outcome.rejected"],
      always["never.trigger"],
    ];
  }
  // An ask's receipt is the answer's own summary ("Refused: <reason>").
  return [...sheet, askCopy(locale).refusedReceipt("Not now")];
}

describe("the verb follows the object", () => {
  it("a proposal is rejected, an ask refused (the vocabulary's verbs)", () => {
    expect(refuseVerb("proposal")).toBe("reject");
    expect(refuseVerb("ask")).toBe("refuse");
    expect(refuseVerb("secret")).toBe("refuse");
  });

  it.each(["proposal", "ask"] as const)(
    "%s: the button and the sheet render its verb",
    (kind) => {
      const verb = refuseVerb(kind);
      const button = text(
        renderToStaticMarkup(<RefuseTrigger kind={kind} onPress={() => {}} />)
      );
      expect(button).toBe(`${resolveActionLabel(verb, "imperative")}…`);
      const sheet = text(
        renderToStaticMarkup(
          <RefuseSheet
            kind={kind}
            busy={false}
            pending={false}
            onRefuse={() => {}}
            onCancel={() => {}}
          />
        )
      );
      const other = verb === "reject" ? "refuse" : "reject";
      expect(sheet.toLowerCase()).toContain(stem(verb, "en"));
      expect(sheet.toLowerCase()).not.toContain(stem(other, "en"));
    }
  );

  for (const locale of LOCALES) {
    it.each(["proposal", "ask"] as const)(
      `%s (${locale}): every word of its turn-down shares one verb`,
      (kind) => {
        const verb = refuseVerb(kind);
        const other = verb === "reject" ? "refuse" : "reject";
        const words = wordsOf(kind, locale);
        expect(words.length).toBeGreaterThanOrEqual(3);
        for (const w of words) {
          expect(w, w).toBeTruthy();
          expect(w.toLowerCase(), w).toContain(stem(verb, locale));
          expect(w.toLowerCase(), w).not.toContain(stem(other, locale));
        }
      }
    );
  }
});

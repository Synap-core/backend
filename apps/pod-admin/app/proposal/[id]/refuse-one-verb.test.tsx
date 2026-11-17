/**
 * A proposal is refused with ONE verb, the vocabulary's `refuse`, from the
 * button to what the page says after (finding 558257f1: a bar said "Reject"
 * over "If you refuse"): the bar's trigger, the sheet's confirm, its
 * consequence lines, the receipt toast and the decided outcome.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveActionLabel } from "@synap-core/types/vocabulary";
import { RefuseTrigger } from "../../_lib/request/refuse-sheet";
import { REQUEST_CATALOGS } from "../../_lib/request/copy";
import * as receipt from "../../_lib/receipt/copy";
import { en as pageEn, fr as pageFr } from "./copy";

const LOCALES = ["en", "fr"] as const;

describe("one verb to refuse a proposal", () => {
  it("the bar's trigger is the vocabulary's refuse", () => {
    const html = renderToStaticMarkup(<RefuseTrigger onPress={() => {}} />);
    expect(html).toContain(`${resolveActionLabel("refuse", "imperative")}…`);
  });

  it.each(LOCALES)(
    "%s: the sheet, the consequence, the receipt and the outcome say it",
    (locale) => {
      const stem = resolveActionLabel("refuse", "imperative", locale)
        .slice(0, 5)
        .toLowerCase();
      const request = REQUEST_CATALOGS[locale];
      const page = locale === "en" ? pageEn : pageFr;
      const receipts = (receipt as Record<string, unknown>)[locale] as Record<
        string,
        string
      >;
      const words = [
        request["refuse.confirm"],
        request["refuse.proposalConsequence"],
        request["refuse.proposalConsequenceAnyone"],
        receipts["reject.applied"],
        receipts["reject.failed"],
        page["outcome.rejected"],
      ];
      for (const w of words) {
        expect(w, w).toBeTruthy();
        expect(w!.toLowerCase(), w).toContain(stem);
        expect(w!.toLowerCase(), w).not.toMatch(/reject|rejet/);
      }
    }
  );
});

import { setAmbientCatalogLocale } from "@synap-core/types/i18n";
import { afterEach, describe, expect, it } from "vitest";
import { requestReadFailure } from "./request-read-failure";

afterEach(() => setAmbientCatalogLocale("en"));

const err = (code: string) => ({ data: { code } });

describe("requestReadFailure: a failed read is not a withdrawn request", () => {
  it("is nothing while the request is on screen", () => {
    expect(requestReadFailure(null, true)).toBeNull();
  });

  it("a read that failed says so and offers Try again", () => {
    for (const code of ["INTERNAL_SERVER_ERROR", "TIMEOUT", "BAD_GATEWAY"]) {
      const f = requestReadFailure(err(code), false);
      expect(f).toMatchObject({
        title: "This request couldn’t be loaded",
        chip: "Couldn’t load",
        retry: true,
      });
      expect(f?.message).not.toMatch(/withdrawn/);
    }
  });

  it("a missing request may have been withdrawn, with no retry", () => {
    for (const f of [
      requestReadFailure(err("NOT_FOUND"), false),
      requestReadFailure(null, false),
    ]) {
      expect(f).toMatchObject({
        title: "This request couldn’t be found",
        retry: false,
      });
      expect(f?.message).toMatch(/withdrawn/);
    }
  });

  it("a refusal says whose it is to share, with no retry", () => {
    const f = requestReadFailure(err("FORBIDDEN"), false);
    expect(f).toMatchObject({ chip: "No access", retry: false });
    expect(f?.message).toMatch(/Ask the person who sent you the link/);
  });

  it("the sentence speaks the reader's words, never ours", () => {
    for (const code of ["NOT_FOUND", "FORBIDDEN", "INTERNAL_SERVER_ERROR"]) {
      const f = requestReadFailure(err(code), false)!;
      expect(`${f.title} ${f.message}`).not.toMatch(
        /Synap app|desktop|proposal|Something went wrong/
      );
    }
  });

  it("a French reader's first screen is French, title included", () => {
    setAmbientCatalogLocale("fr");
    const titles = ["NOT_FOUND", "FORBIDDEN", "INTERNAL_SERVER_ERROR"].map(
      (code) => requestReadFailure(err(code), false)!.title
    );
    expect(titles).toEqual([
      "Cette demande est introuvable",
      "Vous n’avez pas accès à cette demande",
      "Cette demande ne s’est pas chargée",
    ]);
    expect(requestReadFailure(null, false)!.title).toBe(
      "Cette demande est introuvable"
    );
  });

  it("a signed-out reader is told so in the client's words", () => {
    for (const locale of ["en", "fr"] as const) {
      setAmbientCatalogLocale(locale);
      const f = requestReadFailure(err("UNAUTHORIZED"), false)!;
      expect(f.retry).toBe(false);
      expect(`${f.title} ${f.message}`).not.toMatch(/session|pod\b/i);
    }
  });
});

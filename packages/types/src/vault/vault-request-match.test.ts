/**
 * `matchVaultRequestSecrets` — which saved secret an agent's vault request
 * names. The rows are the rule the desktop vault card shipped with (moved
 * here word for word), so the card and the approve executor pick the same one.
 */

import { describe, expect, it } from "vitest";
import { matchVaultRequestSecrets } from "./index";

const fal = {
  id: "s-fal",
  type: "api_key",
  name: "fal.ai Image Generation fal.ai API key",
};
const openai = { id: "s-oai", type: "api_key", name: "OpenAI key" };
const falPassword = { id: "s-falpw", type: "password", name: "fal.ai login" };
const byUrl = {
  id: "s-url",
  type: "api_key",
  name: "Image key",
  url: "https://fal.ai/dashboard",
};

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe("matchVaultRequestSecrets", () => {
  it("matches type AND the service in the name", () => {
    expect(
      ids(
        matchVaultRequestSecrets([fal, openai, falPassword], {
          service: "fal.ai",
          secretType: "api_key",
        })
      )
    ).toEqual(["s-fal"]);
  });

  it("finds the service in the url, category or description too", () => {
    expect(
      ids(
        matchVaultRequestSecrets([byUrl, openai], {
          service: "fal.ai",
          secretType: "api_key",
        })
      )
    ).toEqual(["s-url"]);
  });

  it("ignores case and surrounding space", () => {
    expect(
      ids(
        matchVaultRequestSecrets([fal], {
          service: "  FAL.AI ",
          secretType: "API_KEY",
        })
      )
    ).toEqual(["s-fal"]);
  });

  it("a request naming neither service nor type matches nothing", () => {
    expect(matchVaultRequestSecrets([fal, openai], {})).toEqual([]);
  });

  it("several matches are all returned (the caller decides)", () => {
    expect(
      ids(
        matchVaultRequestSecrets([fal, byUrl], {
          service: "fal.ai",
          secretType: "api_key",
        })
      )
    ).toEqual(["s-fal", "s-url"]);
  });
});

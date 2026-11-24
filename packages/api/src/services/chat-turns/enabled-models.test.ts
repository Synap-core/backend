/**
 * The list an app reads to pick a model: enabled providers only, a stable id per model, one default, and NEVER a
 * secret. The rows carry every secret column the real table has; the sentinels must not appear anywhere in the answer.
 */
import { describe, expect, it } from "vitest";
import { selectableModels } from "./enabled-models.js";

const SECRETS = [
  "ENCRYPTED-KEY-SENTINEL",
  "https://internal.example/v1",
  "SECRET_ENV_VAR",
  "EXTRA-BODY-SENTINEL",
];

const row = (over: Record<string, unknown>) =>
  ({
    providerId: "p",
    name: "P",
    priority: 10,
    enabled: true,
    models: [],
    encryptedApiKey: SECRETS[0],
    baseUrl: SECRETS[1],
    apiKeyEnvVar: SECRETS[2],
    extraBody: { x: SECRETS[3] },
    ...over,
  }) as never;

describe("selectableModels", () => {
  const rows = [
    row({
      providerId: "late",
      name: "Late",
      priority: 20,
      models: [{ id: "m-late", tier: "free" }],
    }),
    row({
      providerId: "openrouter",
      name: "OpenRouter",
      priority: 1,
      models: [
        { id: "anthropic/claude-sonnet-4.5", tier: "advanced" },
        { id: "other" },
      ],
    }),
    row({
      providerId: "off",
      name: "Off",
      priority: 0,
      enabled: false,
      models: [{ id: "hidden" }],
    }),
  ];
  const out = selectableModels(rows);

  it("only enabled providers, in cascade order, with the id a turn accepts", () => {
    expect(out.map((m) => m.id)).toEqual([
      "openrouter/anthropic/claude-sonnet-4.5",
      "openrouter/other",
      "late/m-late",
    ]);
  });

  it("exactly one default: the head of the cascade", () => {
    expect(out.filter((m) => m.isDefault).map((m) => m.id)).toEqual([
      "openrouter/anthropic/claude-sonnet-4.5",
    ]);
  });

  it("carries label, provider and tier", () => {
    expect(out[0]).toEqual({
      id: "openrouter/anthropic/claude-sonnet-4.5",
      label: "anthropic/claude-sonnet-4.5",
      providerId: "openrouter",
      providerName: "OpenRouter",
      tier: "advanced",
      isDefault: true,
    });
  });

  it("no secret column of the row appears anywhere in the answer", () => {
    const wire = JSON.stringify(out);
    expect(out.length).toBeGreaterThan(0);
    for (const s of SECRETS) expect(wire).not.toContain(s);
    expect(wire).not.toMatch(/priority|baseUrl|apiKey|encrypted/i);
  });

  it("no enabled provider: an empty list, no default", () => {
    expect(selectableModels([row({ enabled: false })])).toEqual([]);
  });
});

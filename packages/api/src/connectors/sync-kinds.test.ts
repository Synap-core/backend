import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `connectors.providers[].syncKinds` — what a connection brings, derived from the
 * template's `tools[].metadata.sync.kinds` × the sync door's registered handlers.
 *
 * The template fixture mirrors the shipped `nango-google.capability.json` sync
 * block. The registry is the sync door's REAL one (google kinds registered by side effect),
 * so the profile slugs asserted are the ones the mappers actually write.
 */

const h = vi.hoisted(() => ({
  template: null as unknown,
  fail: false,
}));

vi.mock(
  "../services/capabilities/cp-template-client.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    fetchCPCapabilityTemplate: vi.fn(async () => {
      if (h.fail) throw new Error("catalog cache unavailable");
      return h.template;
    }),
  })
);

import {
  deriveProviderSyncKinds,
  loadProviderSyncKinds,
} from "./sync-kinds.js";
import { getSyncKinds } from "../services/event-sync/sync-kind-registry.js";

const googleTemplate = (
  kinds: Record<string, { enabled?: boolean }>,
  enabled = true
) => ({
  tools: [
    {
      credentialRef: "nango://google",
      metadata: { sync: { enabled, kinds } },
    },
  ],
});

const SHIPPED_KINDS = {
  event: { enabled: true },
  "email.thread": { enabled: true },
  contact: { enabled: true },
};

beforeEach(() => {
  h.template = googleTemplate(SHIPPED_KINDS);
  h.fail = false;
});

describe("deriveProviderSyncKinds", () => {
  const handlers = [
    {
      kind: "event",
      profileSlugs: ["event", "person"],
      defaults: { enabled: true },
    },
    { kind: "contact", profileSlugs: ["person"], defaults: { enabled: true } },
    { kind: "unlisted", profileSlugs: ["note"], defaults: { enabled: true } },
  ];

  it("a kind appears only when the template enables it AND a handler implements it", () => {
    // `email.thread` is EXPLICITLY enabled in the template (as the shipped
    // template declares every kind) but has no handler here — the input that
    // separates "template ∩ handlers" from "template alone". An `{}` entry
    // would not: it is excluded by the missing default either way.
    expect(
      deriveProviderSyncKinds(
        "google",
        googleTemplate({
          event: {},
          contact: { enabled: false },
          "email.thread": { enabled: true },
        }),
        handlers
      )
    ).toEqual([{ kind: "event", profileSlugs: ["event", "person"] }]);
  });

  it("sync off on the tool, or no tool for the provider → brings nothing", () => {
    expect(
      deriveProviderSyncKinds(
        "google",
        googleTemplate(SHIPPED_KINDS, false),
        handlers
      )
    ).toEqual([]);
    expect(
      deriveProviderSyncKinds("notion", googleTemplate(SHIPPED_KINDS), handlers)
    ).toEqual([]);
  });
});

describe("loadProviderSyncKinds — through the real sync-kind registry", () => {
  it("google brings its three shipped kinds, each with the profiles its mapper writes", async () => {
    const registered = getSyncKinds("google")
      .map((k) => k.kind)
      .sort();
    expect(registered).toEqual(["contact", "email.thread", "event"]);

    const kinds = (await loadProviderSyncKinds(["google"])).get("google");
    expect(kinds?.map((k) => k.kind)).toEqual([
      "event",
      "email.thread",
      "contact",
    ]);
    for (const k of kinds!) {
      const handler = getSyncKinds("google").find((x) => x.kind === k.kind)!;
      expect(k.profileSlugs).toEqual(handler.profileSlugs);
      expect(k.profileSlugs.length).toBeGreaterThan(0);
    }
  });

  it("an unreadable template is UNKNOWN (undefined), never an empty list", async () => {
    h.fail = true;
    const kinds = await loadProviderSyncKinds(["google"]);
    expect(kinds.has("google")).toBe(true);
    expect(kinds.get("google")).toBeUndefined();
  });

  it("a provider with no registered sync kind brings nothing ([])", async () => {
    expect((await loadProviderSyncKinds(["notion"])).get("notion")).toEqual([]);
  });
});

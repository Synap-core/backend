import { describe, expect, it } from "vitest";
import {
  bounceReceipt,
  bounceSummary,
  entitySummary,
  openPathForResolved,
  redactSecretProperties,
  type ResolvedOpen,
} from "./open-model";

const ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const WS = "11111111-2222-4333-8444-555555555555";

const resolved = (over: Partial<ResolvedOpen>): ResolvedOpen => ({
  type: "document",
  id: ID,
  displayName: "Q3 plan",
  workspaceId: WS,
  openable: true,
  ...over,
});

describe("bounceReceipt — diagnose.resolveOpen names the bounced object", () => {
  it("names it when the resolver agrees on the kind", () => {
    expect(bounceReceipt("document", resolved({}))).toEqual({
      title: "Q3 plan",
      workspaceId: WS,
    });
  });

  it("refuses a name for a DIFFERENT kind (a wrong name is worse than none)", () => {
    expect(bounceReceipt("document", resolved({ type: "entity" }))).toBeNull();
    expect(
      bounceReceipt("document", resolved({ type: "unknown", openable: false }))
    ).toBeNull();
  });

  it("never falls back to the id; a space has no space", () => {
    expect(
      bounceReceipt("channel", resolved({ type: "channel", displayName: " " }))
    ).toBeNull();
    expect(
      bounceReceipt(
        "workspace",
        resolved({ type: "workspace", workspaceId: ID })
      )?.workspaceId
    ).toBeNull();
    expect(bounceReceipt("document", undefined)).toBeNull();
  });
});

describe("bounceSummary", () => {
  it("names every hosted kind, from HOST_TYPES", () => {
    expect(bounceSummary()).toBe(
      "The web shows entities, views, rules and sessions. Open this one in the Synap app for the full surface."
    );
  });
});

describe("openPathForResolved — the bare /open/<id> resolver", () => {
  it.each([
    ["entity", `/open/entity/${ID}`],
    ["automation", `/open/automation/${ID}`],
    ["session", `/open/session/${ID}`],
    ["document", `/open/document/${ID}`],
    ["skill", `/open/skill/${ID}`],
    ["proposal", `/proposal/${ID}`],
  ])("%s → %s", (type, path) => {
    expect(openPathForResolved(resolved({ type }))).toBe(path);
  });

  it("nothing visible, nothing openable, or an unknown label → stays put", () => {
    expect(
      openPathForResolved(resolved({ type: "unknown", openable: false }))
    ).toBeNull();
    expect(
      openPathForResolved(resolved({ type: "external_send", openable: false }))
    ).toBeNull();
    expect(openPathForResolved(resolved({ type: "spaceship" }))).toBeNull();
  });
});

describe("entitySummary", () => {
  it("prefers the preview column and names no property", () => {
    expect(
      entitySummary({ preview: "Short", properties: { description: "Long" } })
    ).toEqual({ text: "Short", propertySlug: null });
  });

  it("falls back to a prose property and says which", () => {
    expect(entitySummary({ properties: { content: "Body" } })).toEqual({
      text: "Body",
      propertySlug: "content",
    });
    expect(entitySummary({})).toEqual({ text: null, propertySlug: null });
  });
});

describe("redactSecretProperties", () => {
  it("masks secret-typed values only", () => {
    expect(
      redactSecretProperties({ apiKey: "sk-live", name: "Ada", empty: null }, [
        { slug: "apiKey", valueType: "secret" },
        { slug: "name", valueType: "string" },
        { slug: "empty", valueType: "secret" },
      ])
    ).toEqual({ apiKey: "••••••", name: "Ada", empty: null });
  });
});

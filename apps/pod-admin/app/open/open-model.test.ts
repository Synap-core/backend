import { describe, expect, it } from "vitest";
import {
  bounceAddressParams,
  bounceReceipt,
  bounceSummary,
  entitySummary,
  openPathForResolved,
  redactSecretProperties,
  runFlowTypeOf,
  type ResolvedOpen,
} from "./open-model";

const ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const WS = "11111111-2222-4333-8444-555555555555";
const UPDATED = new Date("2026-10-17T09:00:00Z");

const resolved = (over: Partial<ResolvedOpen>): ResolvedOpen => ({
  type: "document",
  id: ID,
  displayName: "Q3 plan",
  workspaceId: WS,
  updatedAt: UPDATED,
  openable: true,
  ...over,
});

describe("bounceReceipt — diagnose.resolveOpen names the bounced object", () => {
  it("names it when the resolver agrees on the kind", () => {
    expect(bounceReceipt("document", resolved({}))).toEqual({
      title: "Q3 plan",
      workspaceId: WS,
      updatedAt: UPDATED,
    });
  });

  it("says nothing of when for a kind that does not record it", () => {
    expect(
      bounceReceipt("document", resolved({ updatedAt: null }))?.updatedAt
    ).toBeNull();
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
    expect(bounceSummary("document")).toBe(
      "The web shows entities, views, rules, sessions, templates, runs, tools and agents. Open this one in the Synap app for the full surface."
    );
  });

  it("never says the web shows the word the bounced kind reads as", () => {
    // A skill and a tool read as "Tool", like a (hosted) capability.
    for (const type of ["tool", "skill"]) {
      expect(bounceSummary(type)).toBe(
        "The web shows entities, views, rules, sessions, templates, runs and agents. Open this one in the Synap app for the full surface."
      );
    }
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

  it("a playbook run keeps its flowType, or the app opens the automation reader", () => {
    expect(
      openPathForResolved(
        resolved({ type: "run", params: { flowType: "playbook" } })
      )
    ).toBe(`/open/run/${ID}?flowType=playbook`);
  });

  it("forwards only allowlisted address params, never a typo or a stray key", () => {
    expect(
      openPathForResolved(
        resolved({
          type: "run",
          params: { flowType: "playbok", x: "1", constructor: "y" },
        })
      )
    ).toBe(`/open/run/${ID}`);
    expect(
      openPathForResolved(
        resolved({ type: "entity", params: { flowType: "playbook" } })
      )
    ).toBe(`/open/entity/${ID}`);
  });
});

describe("bounceAddressParams — what the app link must carry", () => {
  it("takes the run's flowType from the resolver when it agrees on the kind", () => {
    expect(
      bounceAddressParams(
        "run",
        resolved({ type: "run", params: { flowType: "playbook" } })
      )
    ).toEqual({ flowType: "playbook" });
  });

  it("carries nothing on a kind mismatch, a failed lookup or an unknown value", () => {
    expect(
      bounceAddressParams(
        "run",
        resolved({ type: "entity", params: { flowType: "playbook" } })
      )
    ).toBeUndefined();
    expect(bounceAddressParams("run", undefined)).toBeUndefined();
    expect(
      bounceAddressParams(
        "run",
        resolved({ type: "run", params: { flowType: "nope" } })
      )
    ).toBeUndefined();
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

describe("runFlowTypeOf — which run a /open/run page reads", () => {
  it("the link's own flow type wins when it is one runs.get accepts", () => {
    expect(runFlowTypeOf("agent_write", undefined)).toBe("agent_write");
    expect(
      runFlowTypeOf(
        "chat",
        resolved({ type: "run", params: { flowType: "playbook" } })
      )
    ).toBe("chat");
  });

  it("falls back to the resolver when the link has none, or a bad one", () => {
    const run = resolved({ type: "run", params: { flowType: "playbook" } });
    expect(runFlowTypeOf(undefined, run)).toBe("playbook");
    expect(runFlowTypeOf("playbook&x=1", run)).toBe("playbook");
  });

  it("is null when neither can tell — never a guessed automation", () => {
    expect(runFlowTypeOf(undefined, undefined)).toBeNull();
    expect(runFlowTypeOf(undefined, resolved({ type: "unknown" }))).toBeNull();
    expect(
      runFlowTypeOf(
        undefined,
        resolved({ type: "entity", params: { flowType: "playbook" } })
      )
    ).toBeNull();
    expect(
      runFlowTypeOf(
        "nope",
        resolved({ type: "run", params: { flowType: "nope" } })
      )
    ).toBeNull();
  });
});

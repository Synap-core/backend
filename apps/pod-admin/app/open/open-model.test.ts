import { describe, expect, it } from "vitest";
import {
  automationSummary,
  bounceReceipt,
  bounceSummary,
  entitySummary,
  loadFailure,
  openPathForResolved,
  redactSecretProperties,
  sessionCanCancel,
  sessionCanRevert,
  sessionSummary,
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

describe("loadFailure", () => {
  it("speaks in the registry noun, lowercased", () => {
    expect(loadFailure({ data: { code: "NOT_FOUND" } }, "Rule")?.title).toBe(
      "This rule couldn’t be found"
    );
    expect(loadFailure({ data: { code: "FORBIDDEN" } }, "Session")?.chip).toBe(
      "No access"
    );
    expect(loadFailure({ data: { code: "BOOM" } }, "View")?.chip).toBe(
      "Couldn’t load"
    );
  });

  it("is null without an error", () => {
    expect(loadFailure(null, "Entity")).toBeNull();
  });
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

describe("automationSummary", () => {
  const base = {
    status: "active",
    triggerType: "event",
    runCount: 0,
    failureCount: 0,
  };
  it("leads with what is wrong", () => {
    expect(
      automationSummary({ ...base, status: "error", errorMessage: "Bad cron" })
    ).toBe("Stopped on an error: Bad cron");
    expect(automationSummary({ ...base, status: "paused" })).toContain(
      "Paused"
    );
  });

  it("says how it runs, and how often it failed", () => {
    expect(automationSummary(base)).toBe(
      "Runs when its trigger event happens."
    );
    expect(automationSummary({ ...base, runCount: 12, failureCount: 10 })).toBe(
      "Runs when its trigger event happens. 10 of 12 runs failed."
    );
    expect(
      automationSummary({ ...base, triggerType: "cron", nextRunAt: null })
    ).toBe("Runs on a schedule.");
  });
});

describe("session actions and summary", () => {
  it("cancels only work in flight; reverts only what landed", () => {
    expect(sessionCanCancel("active")).toBe(true);
    expect(sessionCanCancel("closed")).toBe(false);
    expect(sessionCanRevert("closed")).toBe(true);
    expect(sessionCanRevert("active")).toBe(false);
  });

  it("reads liveness without folding a failed read into 'never'", () => {
    expect(
      sessionSummary({
        status: "active",
        liveness: { status: "unavailable", reason: "x" },
      })
    ).toBe("In progress.");
    expect(
      sessionSummary({
        status: "active",
        liveness: { status: "ok", lastAgentActivityAt: null },
      })
    ).toBe("In progress — no agent has acted on it yet.");
    expect(sessionSummary({ status: "closed", closedAt: null })).toBe(
      "Closed."
    );
  });
});

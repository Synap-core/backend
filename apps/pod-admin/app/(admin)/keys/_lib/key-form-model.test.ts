import { describe, expect, it } from "vitest";
import {
  DEV_LOOP_POSTER_TEMPLATE_ID,
  keyDraftFromTemplate,
  keyTemplate,
  setGrantLifetime,
  setKeyGrant,
  type KeyCeiling,
  type KeyDraft,
} from "@synap-core/types/grants";
import {
  afterCreateHref,
  cellAllowed,
  defaultTemplateId,
  keyMintCall,
  keyPageParams,
  keyRequestOutcome,
  keyTemplates,
  keyUseAllowed,
  lifetimeChoices,
  newKeyHref,
} from "./key-form-model";

const WS = "2aaaaaaa-0000-4000-8000-000000000001";
const poster = keyTemplate(DEV_LOOP_POSTER_TEMPLATE_ID)!;
const fromPoster: KeyDraft = keyDraftFromTemplate(poster);
const params = (q: string) => {
  const sp = new URLSearchParams(q);
  return keyPageParams((k) => sp.get(k));
};

describe("the page's link (keyPageParams / newKeyHref)", () => {
  it("round-trips a template, a space and a holder", () => {
    const href = newKeyHref({
      template: "read-only",
      space: WS,
      holder: "service",
      name: "n8n",
    });
    expect(href.startsWith("/keys/new?")).toBe(true);
    expect(params(href.split("?")[1])).toEqual({
      templateId: "read-only",
      workspaceId: WS,
      holder: "service",
      name: "n8n",
    });
    expect(newKeyHref()).toBe("/keys/new");
    expect(newKeyHref({ holder: "person" })).toBe("/keys/new");
  });

  // Rules out: a system key made "for a space" (it is pod-wide) and a
  // service key with no space to hold it.
  it("a holder that does not fit the space falls back to the person", () => {
    expect(params(`holder=system&space=${WS}`).holder).toBe("person");
    expect(params("holder=service").holder).toBe("person");
    expect(params("holder=system").holder).toBe("system");
  });

  it("system and service keys open on Full access (D-2's default, shown); a person on scratch", () => {
    expect(defaultTemplateId("system")).toBe("full-access");
    expect(defaultTemplateId("service")).toBe("full-access");
    expect(defaultTemplateId("person")).toBeNull();
  });
});

describe("keyMintCall — the door, and what it is sent", () => {
  it("a person's key goes to apiKeys.create with uses, never a scope", () => {
    const call = keyMintCall("person", fromPoster, null);
    expect(call.door).toBe("create");
    expect(call.input).toMatchObject({
      keyName: poster.name,
      uses: ["hub"],
      grant: { permissions: ["event.create"] },
      expiresInDays: 90,
      templateId: DEV_LOOP_POSTER_TEMPLATE_ID,
    });
    expect(call.input).not.toHaveProperty("scope");
    expect(call.input).not.toHaveProperty("workspaceId");
  });

  it("a key made for a space carries the space; a service key goes to its own door", () => {
    expect(keyMintCall("person", fromPoster, WS).input).toMatchObject({
      workspaceId: WS,
    });
    const svc = keyMintCall("service", fromPoster, WS);
    expect(svc.door).toBe("adminCreateServiceKey");
    expect(svc.input).toMatchObject({ workspaceId: WS, uses: ["hub"] });
    const sys = keyMintCall("system", fromPoster, null);
    expect(sys.door).toBe("createSystemKey");
    expect(sys.input).not.toHaveProperty("workspaceId");
  });

  // D-4: an omitted lifetime is 90 days on every door, so "Never" must be
  // sent, as null. Rules out: "Never" silently becoming 90 days.
  it("Never is sent as null on every door", () => {
    const never = setKeyGrant(
      fromPoster,
      setGrantLifetime(fromPoster.grant, null)
    );
    for (const holder of ["person", "system", "service"] as const)
      expect(keyMintCall(holder, never, WS).input.expiresInDays).toBeNull();
  });
});

describe("after the key is shown once", () => {
  it("opens its row, focused, where it is listed", () => {
    expect(afterCreateHref(null, "k1")).toBe("/keys?focus=k1");
    expect(afterCreateHref(WS, "k1")).toMatch(
      new RegExp(`/${WS}\\?tab=api-keys&focus=k1$`)
    );
  });
});

describe("templates", () => {
  it("built-ins first, then the person's stored roles marked as theirs", () => {
    const stored = {
      id: "8e2c1f0a-0000-4000-8000-000000000001",
      name: "Card site",
      description: "",
      grant: { permissions: ["entity.person.create"] },
    };
    const all = keyTemplates([stored]);
    expect(all[0].id).toBe(DEV_LOOP_POSTER_TEMPLATE_ID);
    expect(all.at(-1)).toMatchObject({ id: stored.id, stored: true });
  });
});

describe("under a CLI request's ceiling: narrow, never widen", () => {
  const ceiling: KeyCeiling = { grant: poster.grant, uses: ["hub"] };

  it("only what the request grants can be ticked", () => {
    expect(cellAllowed(ceiling, { subject: "event", action: "create" })).toBe(
      true
    );
    expect(cellAllowed(ceiling, { subject: "event", action: "read" })).toBe(
      false
    );
    expect(cellAllowed(undefined, { subject: "event", action: "read" })).toBe(
      true
    );
    expect(keyUseAllowed(ceiling, "hub")).toBe(true);
    expect(keyUseAllowed(ceiling, "mcp")).toBe(false);
  });

  it("lifetimes stop at the request's own, and never is not offered", () => {
    expect(lifetimeChoices(ceiling)).toEqual([1, 30, 90]);
    expect(lifetimeChoices(undefined)).toContain(null);
    expect(
      lifetimeChoices({
        ...ceiling,
        grant: { ...poster.grant, expiresInDays: 7 },
      })
    ).toEqual([1, 7]);
  });
});

describe("keyRequestOutcome", () => {
  it("says each closed state in words naming the requester", () => {
    for (const s of ["approved", "consumed", "denied", "expired"] as const) {
      const o = keyRequestOutcome(s, "Antoine's laptop");
      expect(o.title.trim()).not.toBe("");
      expect(o.body.trim()).not.toBe("");
    }
    expect(keyRequestOutcome("approved", "Antoine's laptop").body).toContain(
      "Antoine's laptop"
    );
  });
});

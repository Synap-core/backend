/**
 * What Allow SENDS (review finding 14): the full consent versus the two
 * short asks, with and without the W3d contract, and where a failure is
 * drawn. Pure: pod-admin's vitest runs in node, so the rule ConsentForm
 * spreads into its decide call is tested here (the tripwire pins that it is
 * this rule, `...payload`).
 */
import { describe, expect, it } from "vitest";
import { allowPayload, showsErrorScreen } from "./allow-payload";
import {
  firstDraft,
  offerOf,
  offerOfContract,
  setPermission,
  toggleWritePlace,
  type ConsentAppWire,
  type ConsentContract,
} from "./consent-access";

const SP = (id: string, name: string) => ({
  workspaceId: id,
  workspaceName: name,
  templateSlug: null,
});
const APP: ConsentAppWire = {
  permissions: [
    { permission: "entity.post.read", workspaces: [SP("w-a", "A")] },
    { permission: "entity.post.create", workspaces: [SP("w-a", "A")] },
  ],
  podWide: [],
  templates: [],
};
const PAIRS = {
  pairs: [{ permission: "entity.note.read", workspaceId: "w-a" }],
};
const CONTRACT: ConsentContract = {
  asked: {
    permissions: [
      { permission: "entity.post.read", tier: "read", reason: null, kindGroup: null, allSpaces: false, offerable: true },
      { permission: "entity.post.create", tier: "write", reason: null, kindGroup: null, allSpaces: false, offerable: true },
    ],
    templates: [],
  },
  places: {
    read: { allSpaces: false, spaces: [{ id: "w-a", name: "A", templateSlug: null }], projects: [] },
    write: { spaces: [{ id: "w-a", name: "A", templateSlug: null }], projects: [], suggestedSpaceIds: [] },
  },
  current: null,
  reconsent: null,
  ask: null,
};

describe("what Allow sends", () => {
  it("the full consent, today's pod: pairs only", () => {
    const offer = offerOf(APP);
    const draft = toggleWritePlace(firstDraft(offer), "space", "w-a");
    const p = allowPayload({ app: { ask: null }, contract: null, offer, draft, askWrite: null });
    expect(p.access).toBeUndefined();
    expect(p.approved).toEqual([
      { permission: "entity.post.read", workspaceId: "w-a" },
      { permission: "entity.post.create", workspaceId: "w-a" },
    ]);
  });

  it("the full consent on a W3d pod: pairs AND the v2 access", () => {
    const offer = offerOfContract(CONTRACT);
    const draft = toggleWritePlace(firstDraft(offer), "space", "w-a");
    const p = allowPayload({ app: { ask: null }, contract: CONTRACT, offer, draft, askWrite: null });
    expect(p.access).toEqual({
      version: 2,
      permissions: ["entity.post.read", "entity.post.create"],
      read: { spaces: ["w-a"], projects: [] },
      write: { spaces: ["w-a"], projects: [] },
    });
  });

  it("C3: no write sent, no write place stored", () => {
    const offer = offerOfContract(CONTRACT);
    const draft = setPermission(
      toggleWritePlace(firstDraft(offer), "space", "w-a"),
      "entity.post.create",
      false
    );
    const p = allowPayload({ app: { ask: null }, contract: CONTRACT, offer, draft, askWrite: null });
    expect(p.access!.write).toEqual({ spaces: [], projects: [] });
  });

  it("C7: today's short ask sends exactly its pairs, never a full access, even on a W3d pod", () => {
    const offer = offerOfContract(CONTRACT);
    const draft = firstDraft(offer);
    const p = allowPayload({ app: { ask: PAIRS }, contract: CONTRACT, offer, draft, askWrite: null });
    expect(p).toEqual({
      approved: [{ permission: "entity.note.read", workspaceId: "w-a" }],
    });
  });

  it("C2: the contract's short ask sends neither pairs nor access; its write place only when it needs one", () => {
    const offer = offerOfContract(CONTRACT);
    const askWrite = toggleWritePlace(firstDraft(offer), "space", "w-a");
    const ask = { title: "", adds: [], unavailable: [], connectionPublicId: null };
    const needs = { ...CONTRACT, ask: { ...ask, needsWritePlace: true } };
    const plain = { ...CONTRACT, ask: { ...ask, needsWritePlace: false } };
    expect(
      allowPayload({ app: { ask: PAIRS }, contract: needs, offer, draft: null, askWrite })
    ).toEqual({ askWritePlace: { spaces: ["w-a"], projects: [] } });
    expect(
      allowPayload({ app: { ask: null }, contract: plain, offer, draft: null, askWrite })
    ).toEqual({});
  });

  it("not a pod app: nothing of the app's", () => {
    expect(allowPayload({ app: null, contract: null, offer: null, draft: null, askWrite: null })).toEqual({});
  });

  it("C6: a pod app's failure is drawn inline, never also on its own screen", () => {
    expect(showsErrorScreen({ kind: "error" }, { ask: null })).toBe(false);
    expect(showsErrorScreen({ kind: "error" }, null)).toBe(true);
    expect(showsErrorScreen({ kind: "idle" }, null)).toBe(false);
  });
});

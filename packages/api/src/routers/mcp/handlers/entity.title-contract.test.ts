/**
 * THE TITLE CONTRACT at the MCP entity doors (plan 9992207a, `c-title-contract`).
 *
 * The pod never shortened a title, but no writer was ever told a title was
 * bad: 694 knowledge titles were cut client-side (at 120, later ~80 + "…") and
 * every receipt came back clean. Now:
 *
 *  1. A long title reaches the entity door WHOLE — never cut on the way.
 *  2. The write receipt carries `titleLint` (the shared rubric,
 *     `@synap-core/types/titles`) naming what to rewrite; a clean title gets
 *     none. A title cut from its knowledge claim is reported as cut.
 *  3. Over the hard cap (200) the write is refused with the real length,
 *     before anything is written.
 *
 * Driven through the real handler and the real receipt builder; only the hub
 * caller and the name resolver (DB reads) are faked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  createCalls: [] as Array<Record<string, unknown>>,
  updateCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../services/entity-resolution.js", () => ({
  resolveEntityByName: async () => ({ sameProfile: null, otherProfiles: [] }),
}));

vi.mock("../../hub-protocol/utils.js", () => ({
  createHubProtocolCallerContext: async () => ({}),
}));

import { entityHandlers } from "./entity.js";
import type { McpToolContext } from "./shared.js";

const fakeLensCaller = {
  entities: {
    createEntity: async (input: Record<string, unknown>) => {
      h.createCalls.push(input);
      return { status: "created", id: "eeeeeeee-1111-4111-8111-111111111111" };
    },
    updateEntity: async (input: Record<string, unknown>) => {
      h.updateCalls.push(input);
      return { status: "updated", entityId: input.entityId };
    },
  },
};

function ctx(toolName: string, args: Record<string, unknown>): McpToolContext {
  return {
    toolName,
    args,
    userId: "user-owner",
    apiKeyScopes: ["mcp.read", "mcp.write"],
    lensCaller: fakeLensCaller,
    caller: {},
  } as unknown as McpToolContext;
}

type Result = { content: Array<{ text?: string }>; isError?: boolean };
const payload = (r: Result) => JSON.parse(r.content[0]!.text!);
const create = (args: Record<string, unknown>) =>
  entityHandlers.synap_create_entity!(
    ctx("synap_create_entity", args)
  ) as Promise<Result>;
const update = (args: Record<string, unknown>) =>
  entityHandlers.synap_update_entity!(
    ctx("synap_update_entity", args)
  ) as Promise<Result>;

const CLAIM =
  "A pod-wide key_revoked with no keyIdPrefix means the pod lost its signing key, not that every agent key was revoked; check the pod before re-minting keys.";

beforeEach(() => {
  h.createCalls = [];
  h.updateCalls = [];
});

describe("synap_create_entity — the title contract", () => {
  it("stores a 130-character title whole and warns in the receipt", async () => {
    const title =
      `Grants deny by default for every agent key${" and every app key".repeat(5)}`.slice(
        0,
        130
      );
    expect(title.length).toBe(130);
    const out = payload(await create({ profileSlug: "knowledge", title }));
    expect(h.createCalls[0]!.title).toBe(title);
    const codes = out.writeReceipt.titleLint.map(
      (i: { code: string }) => i.code
    );
    expect(codes).toContain("too_long");
    expect(out.writeReceipt.titleLint[0].message).toMatch(/130 characters/);
  });

  it("returns no titleLint for a clean title", async () => {
    const out = payload(
      await create({
        profileSlug: "knowledge",
        title: "Grants deny by default for every agent key",
      })
    );
    expect(out.writeReceipt.titleLint).toBeUndefined();
    expect(out.writeReceipt.state).toBe("applied");
  });

  it("reports a title cut from its claim as cut, even without an ellipsis", async () => {
    const out = payload(
      await create({
        profileSlug: "knowledge",
        title: CLAIM.slice(0, 60),
        properties: { knowledgeForm: "caution", ek_claim: CLAIM },
      })
    );
    const codes = out.writeReceipt.titleLint.map(
      (i: { code: string }) => i.code
    );
    expect(codes).toEqual(["truncated"]);
  });

  it("refuses a title over 200 characters before writing anything", async () => {
    const r = await create({
      profileSlug: "knowledge",
      title: "x".repeat(230),
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/230 characters; the limit is 200/);
    expect(h.createCalls).toHaveLength(0);
  });
});

describe("synap_update_entity — the title contract", () => {
  const entityId = "eeeeeeee-2222-4222-8222-222222222222";

  it("warns on a bad new title and passes it through unchanged", async () => {
    const out = payload(
      await update({ entityId, title: "Agent DELETE fix verified live" })
    );
    expect(h.updateCalls[0]!.title).toBe("Agent DELETE fix verified live");
    expect(out.titleLint.map((i: { code: string }) => i.code)).toContain(
      "status_word"
    );
    expect(out.status).toBe("updated");
  });

  it("adds nothing when the title is clean or not sent", async () => {
    expect(
      payload(
        await update({ entityId, title: "Agent deletes always go to review" })
      ).titleLint
    ).toBeUndefined();
    expect(
      payload(await update({ entityId, properties: { a: 1 } })).titleLint
    ).toBeUndefined();
  });

  it("refuses a title over 200 characters before writing anything", async () => {
    const r = await update({ entityId, title: "y".repeat(201) });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/201 characters/);
    expect(h.updateCalls).toHaveLength(0);
  });
});

describe("synap_update_entity — kind conversion (c-kind-convert)", () => {
  const entityId = "eeeeeeee-3333-4333-8333-333333333333";

  it("forwards profileSlug, and a kind-only call is not a no-op", async () => {
    const out = payload(await update({ entityId, profileSlug: "decision" }));
    expect(h.updateCalls).toHaveLength(1);
    expect(h.updateCalls[0]).toMatchObject({
      entityId,
      profileSlug: "decision",
    });
    expect(out.status).toBe("updated");
  });

  it("CONTROL: an ordinary update sends no profileSlug", async () => {
    await update({ entityId, title: "Agent deletes always go to review" });
    expect(h.updateCalls[0]).not.toHaveProperty("profileSlug");
  });
});

/**
 * GUARD — recall never feeds a REPLACED record to the answer, and never lets
 * it vanish either (finding 9c1d7dac: "Recall still lists a superseded
 * knowledge entity as a source").
 *
 * A knowledge or decision entity whose `properties.supersededBy` is set was
 * listed in `synap_ask`'s `sources` and its body went into the synthesis
 * context, so the answer could state the replaced fact as current. The fix
 * sits where every recall leg converges (`buildSynthesisContext`) and reads
 * ONE predicate (`supersededByOf`), keyed on the property, never on the kind.
 *
 * Asserted by REACHABILITY: the replaced record's body is absent from the
 * context the IS receives, its id is absent from `sources`, and its
 * replacement's id arrives at the MCP door in `superseded`. Records without
 * the property are untouched (no notice, no field, same budget).
 * Only retrieval (`ask`), the lens and the network are stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getDefaultActiveService, askMock } = vi.hoisted(() => ({
  getDefaultActiveService: vi.fn(),
  askMock: vi.fn(),
}));

vi.mock("../../../utils/intelligence-routing.js", () => ({
  getDefaultActiveService,
}));
vi.mock("../ask.js", () => ({ ask: askMock }));
vi.mock("../resolve-lens.js", () => ({
  resolveKnowledgeLens: async () => ({ workspaceId: null, catalog: [] }),
}));

import { buildSynthesisContext, synthesizeAnswer } from "../synthesize.js";
import { supersededByOf } from "../superseded.js";
import type { AskAnswer } from "../ask.js";
import { readHandlers } from "../../../routers/mcp/handlers/read.js";
import type { McpToolContext } from "../../../routers/mcp/handlers/shared.js";

const OLD_ID = "11111111-1111-4111-8111-111111111111";
const NEW_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";

const OLD = {
  id: OLD_ID,
  title: "Deploy gotcha (old)",
  properties: {
    knowledgeForm: "caution",
    ek_claim: "OLDMARK deploys must run from the shared tree",
    supersededBy: NEW_ID,
  },
};
const NEW = {
  id: NEW_ID,
  title: "Deploy gotcha (current)",
  properties: {
    knowledgeForm: "caution",
    ek_claim: "NEWMARK deploys run from a clean checkout of a commit",
  },
};
const OTHER = {
  id: OTHER_ID,
  title: "Deploy runbook",
  properties: { content: "OTHERMARK steps" },
};

function semantic(...items: Record<string, unknown>[]): AskAnswer[] {
  return [{ substrate: "semantic", status: "ok", items }] as AskAnswer[];
}

describe("supersededByOf — one predicate, keyed on the property", () => {
  it("reads knowledge's and decision's supersededBy alike", () => {
    expect(supersededByOf(OLD)).toBe(NEW_ID);
    expect(
      supersededByOf({
        id: "d",
        properties: { decisionStatus: "superseded", supersededBy: NEW_ID },
      })
    ).toBe(NEW_ID);
  });

  it("tolerates the slug spellings a define_kind can store", () => {
    expect(supersededByOf({ properties: { supersededby: NEW_ID } })).toBe(
      NEW_ID
    );
    expect(supersededByOf({ properties: { "superseded-by": NEW_ID } })).toBe(
      NEW_ID
    );
  });

  it("is null for a current record, an empty pointer, or no properties", () => {
    expect(supersededByOf(NEW)).toBeNull();
    expect(supersededByOf({ properties: { supersededBy: "  " } })).toBeNull();
    expect(supersededByOf({ properties: { supersededBy: null } })).toBeNull();
    expect(supersededByOf({ id: "x", key: "deploy:backend" })).toBeNull();
  });
});

describe("buildSynthesisContext — a replaced record is left out and named", () => {
  it("keeps the replaced body out of the context and its id out of sources", () => {
    const { context, sources, superseded } = buildSynthesisContext(
      semantic(OLD, NEW, OTHER)
    );
    expect(context).not.toContain("OLDMARK");
    expect(context).toContain("NEWMARK");
    expect(context).toContain("OTHERMARK");
    expect(sources.map((s) => s.id)).toEqual([NEW_ID, OTHER_ID]);
    expect(superseded).toEqual([
      {
        substrate: "semantic",
        id: OLD_ID,
        title: "Deploy gotcha (old)",
        supersededBy: NEW_ID,
      },
    ]);
  });

  it("tells the model what replaced it, by title when it was retrieved", () => {
    const { context } = buildSynthesisContext(semantic(OLD, NEW));
    expect(context).toContain("[NOTICE] SUPERSEDED: 1 retrieved item was");
    expect(context).toContain(
      '"Deploy gotcha (old)" → "Deploy gotcha (current)"'
    );
  });

  it("names the replacement by id when retrieval did not match it", () => {
    const { context, sources, superseded } = buildSynthesisContext(
      semantic(OLD)
    );
    expect(sources).toEqual([]);
    expect(superseded?.[0]?.supersededBy).toBe(NEW_ID);
    expect(context).toContain(`entity ${NEW_ID} (not retrieved)`);
    expect(context).not.toContain("OLDMARK");
  });

  it("does not count a replaced record as an omitted one", () => {
    const filler = Array.from({ length: 20 }, (_, i) => ({
      id: `ent-${i}`,
      title: `Entity ${i}`,
      content: "z".repeat(1500),
    }));
    const { truncated } = buildSynthesisContext(semantic(OLD, ...filler));
    expect(truncated?.total).toBe(20);
    expect(truncated?.omittedSources.map((s) => s.id)).not.toContain(OLD_ID);
  });

  it("changes nothing for records without supersededBy", () => {
    const res = buildSynthesisContext(semantic(NEW, OTHER));
    expect(res.superseded).toBeUndefined();
    expect("superseded" in res).toBe(false);
    expect(res.context).not.toContain("SUPERSEDED");
    expect(res.sources.map((s) => s.id)).toEqual([NEW_ID, OTHER_ID]);
  });
});

describe("synthesizeAnswer — every path carries `superseded`", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("detail: sources lists the replacement without a model call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await synthesizeAnswer(
      semantic(OLD, NEW),
      "q",
      ["semantic"],
      null,
      0,
      [],
      "sources"
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.sources.map((s) => s.id)).toEqual([NEW_ID]);
    expect(res.superseded?.[0]).toMatchObject({
      id: OLD_ID,
      supersededBy: NEW_ID,
    });
  });

  it("the IS never receives the replaced body", async () => {
    getDefaultActiveService.mockResolvedValue({
      endpoint: "http://is.test",
      apiKey: "k",
    });
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ answer: "current answer" }),
    });
    vi.stubGlobal("fetch", fetchSpy);
    const res = await synthesizeAnswer(
      semantic(OLD, NEW),
      "q",
      ["semantic"],
      null
    );
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as { body: string }).body
    ) as { context: string };
    expect(body.context).not.toContain("OLDMARK");
    expect(body.context).toContain("NEWMARK");
    expect(res.superseded?.[0]?.supersededBy).toBe(NEW_ID);
  });
});

describe("synap_ask (MCP door) — the replacement reaches the agent", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("returns superseded with its replacement and keeps it out of sources", async () => {
    askMock.mockResolvedValue({
      answers: semantic(OLD, OTHER),
      routedTo: ["semantic"],
      degraded: [],
      pending: null,
      understanding: {},
    });
    getDefaultActiveService.mockResolvedValue({
      endpoint: "http://is.test",
      apiKey: "k",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ answer: "an answer" }),
      })
    );
    const ctx = {
      toolName: "synap_ask",
      args: { query: "deploy gotchas" },
      userId: "user-1",
      apiKeyScopes: ["mcp.read"],
      workspaceId: null,
      caller: {},
      lensCaller: {},
      workspaceAccessible: false,
    } as unknown as McpToolContext;

    const result = await readHandlers.synap_ask!(ctx);
    const payload = JSON.parse(
      (result.content as { type: string; text: string }[])
        .map((c) => c.text)
        .join("")
    ) as {
      sources: { id: string }[];
      superseded?: { id: string; supersededBy: string }[];
    };
    expect(payload.sources.map((s) => s.id)).toEqual([OTHER_ID]);
    expect(payload.superseded).toEqual([
      expect.objectContaining({ id: OLD_ID, supersededBy: NEW_ID }),
    ]);
  });
});

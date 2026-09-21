/**
 * Hub REST `POST /api/hub/skills` — the SEAM, not the ends.
 *
 * WHAT THIS PINS, and why each is a defect that shipped or nearly did:
 *
 *  1. The route reaches the GOVERNED procedure. `skills.create` is the one
 *     door; the gate (`checkPermissionOrPropose`) is what makes an
 *     agent-authored skill a PROPOSAL rather than a live prompt fragment. The
 *     test drives the real route → real `skillsRouter` → the gate, and asserts
 *     on what the GATE received. Nothing between is hand-built.
 *
 *  2. `body` reaches the `body` column and `code` reaches `code` — SEPARATELY.
 *     Until 2026-09-21 this route folded `body` into `code` ("an alias"),
 *     which predated the `skills.body` column. The result was the signature
 *     defect of this repo: a teaching skill authored through this door was
 *     UNREACHABLE, because `resolveSkillContent` (behind `load_skill`) selects
 *     `skills.body` and nothing else — while every type checked and the door
 *     answered 200.
 *
 *  3. `kind` is DERIVED, not defaulted to "code". Prose-only ⇒ "instruction".
 *     The old default stored Markdown as executable source.
 *
 *  4. `slug` is forwarded, and a documentation-only skill WITHOUT one is
 *     refused BEFORE the gate — the slug is the ref `load_skill` resolves, so
 *     a slugless prose skill is authored-but-unreachable by construction.
 *
 *  5. An agent-key create comes back `{status:"proposed"}` with HTTP 200 and
 *     writes NO row: a proposal is a success, and the prose must not be able
 *     to reach an agent's prompt before a human approves it.
 *
 * NOT covered, measured: no live HTTP round-trip and no real database — the
 * gate and the DB are replaced, so this proves the PROJECTION reaching the
 * governed door, not the row that a later approval materializes.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  gateCalls: [] as Array<Record<string, unknown>>,
  inserts: 0,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    getDb: vi.fn(async () => ({
      insert: vi.fn(() => {
        h.inserts++;
        throw new Error("an agent create must not write a skills row");
      }),
      query: { skills: { findFirst: vi.fn(async () => null) } },
    })),
  };
});

vi.mock("../../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: vi.fn(async (opts: Record<string, unknown>) => {
      h.gateCalls.push(opts);
      return { proposalId: "prop-skill-1", proposalType: "skill.create" };
    }),
  };
});

const { registerSkillsCrudRoutes } = await import("./skills-crud.js");

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

const HOUSE_STYLE = "# House style\n\nAlways lead with the decision.";

function buildApp() {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    c.set("scopes" as never, ["hub-protocol.write"] as never);
    c.set("userId" as never, USER as never);
    c.set("agentUserId" as never, AGENT as never);
    await next();
  });
  registerSkillsCrudRoutes(app as never);
  return app;
}

async function post(payload: Record<string, unknown>) {
  const res = await buildApp().request("/skills", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

beforeEach(() => {
  h.gateCalls.length = 0;
  h.inserts = 0;
});

describe("POST /skills — projection into the governed door", () => {
  it("a prose-only skill reaches the gate as kind:instruction with body set, code null, slug forwarded", async () => {
    const res = await post({
      name: "house_style",
      slug: "biz/house-style",
      body: HOUSE_STYLE,
      description: "How we write.",
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "proposed",
      proposalId: "prop-skill-1",
    });
    // No row: the prose cannot reach an agent's prompt before approval.
    expect(h.inserts).toBe(0);

    expect(h.gateCalls).toHaveLength(1);
    const gate = h.gateCalls[0]!;
    expect(gate).toMatchObject({
      subjectType: "skill",
      action: "create",
      agentUserId: AGENT,
    });
    const data = gate.data as Record<string, unknown>;
    // THE seam: body ≠ code, and the kind is derived from code ABSENCE.
    expect(data.kind).toBe("instruction");
    expect(data.body).toBe(HOUSE_STYLE);
    expect(data.code).toBeNull();
    expect(data.slug).toBe("biz/house-style");
    expect(data.name).toBe("house_style");
  });

  it("an executable skill still derives kind:code and keeps code in `code`", async () => {
    await post({
      name: "normalize_phone",
      code: "return 1;",
      body: "What it does.",
      slug: "util/normalize-phone",
    });

    const data = h.gateCalls[0]!.data as Record<string, unknown>;
    expect(data.kind).toBe("code");
    expect(data.code).toBe("return 1;");
    expect(data.body).toBe("What it does.");
  });

  it("an explicit caller-sent kind is still honoured (back-compat)", async () => {
    await post({
      name: "declared",
      kind: "instruction",
      code: "return 1;",
      slug: "util/declared",
    });
    expect((h.gateCalls[0]!.data as Record<string, unknown>).kind).toBe(
      "instruction"
    );
  });

  it("refuses a documentation-only skill with no slug BEFORE the gate", async () => {
    const res = await post({ name: "unreachable", body: HOUSE_STYLE });

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/slug is required/i);
    expect(h.gateCalls).toHaveLength(0);
    expect(h.inserts).toBe(0);
  });

  it("refuses a skill with neither documentation nor code", async () => {
    const res = await post({ name: "empty", slug: "util/empty" });
    expect(res.status).toBe(400);
    expect(h.gateCalls).toHaveLength(0);
  });

  it("403s without hub-protocol.write", async () => {
    const app = new OpenAPIHono();
    app.use("*", async (c, next) => {
      c.set("scopes" as never, ["hub-protocol.read"] as never);
      c.set("userId" as never, USER as never);
      await next();
    });
    registerSkillsCrudRoutes(app as never);
    const res = await app.request("/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", body: "y", slug: "a/b" }),
    });
    expect(res.status).toBe(403);
    expect(h.gateCalls).toHaveLength(0);
  });
});

/**
 * Hub REST skill doors render tool names for Raycast — through the REAL routes
 * (`GET /agent-skills/by-slug/:slug`, `GET /briefs`), the REAL door resolver and
 * the REAL renderer. Mocked: the database boundary (skill row + the acting
 * agent's `users.agentType`) and, for briefs, the composer's output text.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const AGENT = "0ccccccc-0000-4000-8000-000000000003";
const HUMAN = "0bbbbbbb-0000-4000-8000-000000000002";
const BODY =
  "Call `synap_define_kind` after `list_profiles`; then `synap_load_skill`.";

const h = vi.hoisted(() => ({ agentType: null as string | null }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const rowsFor = (table: unknown) =>
    table === actual.users
      ? h.agentType === null
        ? []
        : [{ agentType: h.agentType }]
      : [
          {
            id: "0ddddddd-0000-4000-8000-000000000004",
            slug: "system/synap/escalation-ladder",
            name: "Escalation ladder",
            description: null,
            topics: [],
            body: BODY,
            source: null,
            author: null,
            version: null,
            tags: [],
            teachesTools: [],
            skillGroup: null,
            alwaysOn: false,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          },
        ];
  return {
    ...actual,
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({ limit: async () => rowsFor(table) }),
        }),
      }),
    },
  };
});
vi.mock(
  "../../../services/capability-briefs/compose-capability-brief.js",
  () => ({
    composeCapabilityBrief: async () =>
      "Teaching: load the full body with `synap_load_skill`.",
  })
);

const { registerAgentSkillsRoutes } = await import("./agent-skills.js");
const { registerBriefsRoutes } = await import("./briefs.js");

function makeApp(agentUserId?: string) {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    c.set("scopes" as never, ["hub-protocol.read"] as never);
    c.set("userId" as never, HUMAN as never);
    if (agentUserId) c.set("agentUserId" as never, agentUserId as never);
    await next();
  });
  registerAgentSkillsRoutes(app as never);
  registerBriefsRoutes(app as never);
  return app;
}

beforeEach(() => {
  h.agentType = null;
});

describe("GET /agent-skills/by-slug/:slug door rendering", () => {
  it("a Raycast agent reads Raycast tool names", async () => {
    h.agentType = "raycast";
    const res = await makeApp(AGENT).request(
      "/agent-skills/by-slug/system%2Fsynap%2Fescalation-ladder"
    );
    expect(res.status).toBe(200);
    const body = ((await res.json()) as { body: string }).body;
    expect(body).toBe(
      "Call `define-kind` after `list-profiles`; then `load-skill`."
    );
  });

  it("a non-Raycast REST caller (IS, CLI) gets the source text", async () => {
    h.agentType = "claude-code";
    const res = await makeApp(AGENT).request(
      "/agent-skills/by-slug/system%2Fsynap%2Fescalation-ladder"
    );
    expect(((await res.json()) as { body: string }).body).toBe(BODY);
  });
});

describe("GET /briefs door rendering", () => {
  it("a Raycast agent's briefs name Raycast tools", async () => {
    h.agentType = "raycast";
    const res = await makeApp(AGENT).request("/briefs?tools=synap_define_kind");
    expect(res.status).toBe(200);
    const { briefs } = (await res.json()) as { briefs: Record<string, string> };
    expect(briefs.synap_define_kind).toBe(
      "Teaching: load the full body with `load-skill`."
    );
  });

  it("a human caller's briefs keep the source text", async () => {
    const res = await makeApp().request("/briefs?tools=synap_define_kind");
    const { briefs } = (await res.json()) as { briefs: Record<string, string> };
    expect(briefs.synap_define_kind).toBe(
      "Teaching: load the full body with `synap_load_skill`."
    );
  });
});

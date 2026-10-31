/**
 * `include` reaches the ONE status read through each of its three doors
 * (status-first plan PR-C): tRPC `lifecycle.statusOf`, Hub `GET /orient`
 * (`?statusOf=&include=`) and MCP `synap_orient` (`statusOf` + `include`).
 * Each door accepts every part `STATUS_OF_INCLUDES` names and hands it on;
 * each refuses a part it does not know, never drops it silently. The MCP
 * tool schema and its committed manifest list the same parts.
 *
 * DB-independent: `discover` (the orient service) is replaced by a recorder,
 * so what is asserted is what each door PASSES; the read itself is proven on
 * PGlite in `status.pglite.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ZodTypeAny } from "zod";
import { OpenAPIHono } from "@hono/zod-openapi";

const h = vi.hoisted(() => ({
  discoverCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../discover/discover.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../discover/discover.js")>()),
  discover: async (p: Record<string, unknown>) => {
    h.discoverCalls.push(p);
    return { startHere: {} };
  },
}));

vi.mock("../../../routers/hub-protocol/rest/_shared.js", async (orig) => ({
  ...(await orig<
    typeof import("../../../routers/hub-protocol/rest/_shared.js")
  >()),
  getCaller: async () => ({ marker: "caller" }),
}));

import { STATUS_OF_INCLUDES } from "@synap-core/types/units";
import { lifecycleRouter } from "../../../routers/lifecycle.js";
import { workspaceHandlers } from "../../../routers/mcp/handlers/workspace.js";
import type { McpToolContext } from "../../../routers/mcp/handlers/shared.js";
import { tools } from "../../../routers/mcp/tools/index.js";
import { registerOrientRoutes } from "../../../routers/hub-protocol/rest/orient.js";
import type {
  HubHono,
  HubVariables,
} from "../../../routers/hub-protocol/rest/_shared.js";

const ID = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
  h.discoverCalls = [];
});

describe("tRPC lifecycle.statusOf", () => {
  /** The router's OWN input parser, never a rebuilt copy. */
  const input = (): ZodTypeAny => {
    const parser = (
      lifecycleRouter as unknown as {
        _def: {
          procedures: Record<string, { _def: { inputs: ZodTypeAny[] } }>;
        };
      }
    )._def.procedures.statusOf?._def?.inputs?.[0];
    if (!parser || typeof parser.safeParse !== "function") {
      throw new Error(
        "statusOf input parser not reachable: this guard is blind"
      );
    }
    return parser;
  };

  it("accepts every part STATUS_OF_INCLUDES names", () => {
    expect(STATUS_OF_INCLUDES).toEqual([
      "moves",
      "history",
      "links",
      "rollup",
      "signals",
      "episodes",
    ]);
    const parsed = input().safeParse({
      ids: [ID],
      include: [...STATUS_OF_INCLUDES],
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a part it does not know", () => {
    expect(
      input().safeParse({ ids: [ID], include: ["history", "everything"] })
        .success
    ).toBe(false);
  });
});

describe("Hub GET /orient ?include=", () => {
  const app = () => {
    const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
    hub.use("/*", async (c, next) => {
      c.set("userId", "owner");
      c.set("scopes", ["hub-protocol.read"]);
      await next();
    });
    registerOrientRoutes(hub);
    return hub;
  };

  it("hands the parts on with the ids", async () => {
    const res = await app().request(
      `/orient?statusOf=${ID}&include=history,rollup,signals`
    );
    expect(res.status).toBe(200);
    expect(h.discoverCalls).toHaveLength(1);
    expect(h.discoverCalls[0]).toMatchObject({
      statusOf: [ID],
      statusOfInclude: ["history", "rollup", "signals"],
    });
  });

  it("refuses an unknown part with a 400, before any read", async () => {
    const res = await app().request(`/orient?statusOf=${ID}&include=gossip`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("history"),
    });
    expect(h.discoverCalls).toHaveLength(0);
  });
});

describe("MCP synap_orient include", () => {
  const orient = (args: Record<string, unknown>) =>
    workspaceHandlers.synap_orient!({
      toolName: "synap_orient",
      args,
      userId: "u1",
      agentUserId: "agent-1",
      apiKeyScopes: ["mcp.read"],
      caller: {} as McpToolContext["caller"],
      lensCaller: {} as McpToolContext["lensCaller"],
      workspaceAccessible: false,
    } as McpToolContext);

  it("hands the parts on with the ids", async () => {
    await orient({ statusOf: [ID], include: ["links", "moves"] });
    expect(h.discoverCalls).toHaveLength(1);
    expect(h.discoverCalls[0]).toMatchObject({
      statusOf: [ID],
      statusOfInclude: ["links", "moves"],
    });
  });

  it("refuses an unknown part, before any read", async () => {
    await expect(
      orient({ statusOf: [ID], include: ["gossip"] })
    ).rejects.toThrow();
    expect(h.discoverCalls).toHaveLength(0);
  });

  it("the tool schema and its committed manifest list the same parts", async () => {
    const listed = (await tools.list()).find((t) => t.name === "synap_orient");
    const include = (
      listed?.inputSchema.properties as Record<
        string,
        { items?: { enum?: string[] } }
      >
    )?.include;
    expect(include?.items?.enum).toEqual([...STATUS_OF_INCLUDES]);
    const manifest = JSON.parse(
      readFileSync(
        join(__dirname, "../../../routers/mcp/tools/mcp-tools.manifest.json"),
        "utf8"
      )
    ) as {
      tools: Array<{
        name: string;
        inputSchema: {
          properties: Record<string, { items?: { enum?: string[] } }>;
        };
      }>;
    };
    expect(
      manifest.tools.find((t) => t.name === "synap_orient")?.inputSchema
        .properties.include?.items?.enum
    ).toEqual([...STATUS_OF_INCLUDES]);
  });
});

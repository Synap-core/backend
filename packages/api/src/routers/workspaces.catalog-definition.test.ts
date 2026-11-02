/**
 * A catalog definition the pod's schema refuses is a typed 400 that names the
 * TEMPLATE and each failing FIELD, on the person's door and on the Hub update
 * door, never "has an invalid definition" (incident 2026-11-02: Content OS's
 * "Produce Content" draft stage goal was 5,225 characters against the stage
 * schema's 5,000, and pod admin said only `Template "content-os" has an
 * invalid definition`).
 *
 * Real: `resolveCatalogTemplateBody` (the one parse of a catalog body, shared
 * by `installFromCatalog` and an agent's update request), the refusal
 * (`services/package-updates/refusals.ts`) and the Hub door's error body.
 * Stubbed: the template resolver, the tier gate, the pod-admin check and the
 * update service (which, in the Hub case, calls the real parse).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  resolve: vi.fn(),
  apply: vi.fn(),
}));

vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: async () => false,
}));
vi.mock("../services/capabilities/resolve-workspace-template.js", () => ({
  resolveWorkspaceTemplate: (...a: unknown[]) => m.resolve(...a),
}));
vi.mock("../utils/tier-check.js", () => ({
  assertPackageTierAccess: async () => undefined,
}));
vi.mock("../trpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../trpc.js")>()),
  assertPodAdmin: async () => undefined,
}));
vi.mock("../services/package-updates/apply.js", () => ({
  applyPackageUpdate: (...a: unknown[]) => m.apply(...a),
}));
vi.mock("./hub-protocol/utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./hub-protocol/utils.js")>()),
  createHubProtocolCallerContext: async () => ({}),
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import { resolveCatalogTemplateBody } from "./workspaces.js";
import { refusalReasonOf } from "../services/package-updates/refusals.js";
import { registerPackageUpdatesRoutes } from "./hub-protocol/rest/package-updates.js";
import type { HubHono, HubVariables } from "./hub-protocol/rest/_shared.js";

const FIELD = "playbooks.0.stages.0.goal";

/** The real stage's shape, cut down; `goalLength` is the draft goal's. */
const contentOsLike = (goalLength: number) => ({
  _meta: { slug: "content-os" },
  playbooks: [
    {
      name: "Produce Content",
      goalTemplate: "Produce content for {platform} from this idea ({post}).",
      stages: [
        {
          key: "draft",
          name: "Draft",
          category: "started",
          subjectStatus: "In Draft",
          gate: { kind: "human" },
          onFail: { toStage: "script" },
          goal: "x".repeat(goalLength),
        },
      ],
    },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveCatalogTemplateBody", () => {
  it("refuses an over-long stage goal naming the template and the field", async () => {
    m.resolve.mockResolvedValue({
      packageDefinition: contentOsLike(5225),
      version: "h-1",
    });
    const err = await resolveCatalogTemplateBody("user-1", "content-os").catch(
      (e: unknown) => e
    );
    expect(err).toMatchObject({ code: "BAD_REQUEST" });
    expect(refusalReasonOf(err)).toBe("INVALID_CATALOG_DEFINITION");
    expect((err as Error).message).toContain('"content-os"');
    expect((err as Error).message).toContain(FIELD);
  });

  it("reads the same body at the 5,000 cap (the cap is what is refused)", async () => {
    m.resolve.mockResolvedValue({
      packageDefinition: contentOsLike(5000),
      version: "h-1",
    });
    const { body, version } = await resolveCatalogTemplateBody(
      "user-1",
      "content-os"
    );
    expect(version).toBe("h-1");
    expect(body._meta?.slug).toBe("content-os");
  });
});

describe("POST /package-updates/{slug}/apply — an invalid catalog definition", () => {
  function app(): HubHono {
    const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
    a.use("/*", async (c, next) => {
      c.set("userId", "user-1");
      c.set("agentUserId", "agent-1");
      c.set("scopes", ["hub-protocol.write", "hub-protocol.read"]);
      await next();
    });
    registerPackageUpdatesRoutes(a);
    return a;
  }

  it("is a 400 with its reasonCode and the failing field, not a 500", async () => {
    m.resolve.mockResolvedValue({
      packageDefinition: contentOsLike(5225),
      version: "h-1",
    });
    m.apply.mockImplementation(() =>
      resolveCatalogTemplateBody("user-1", "content-os")
    );
    const res = await app().request("/package-updates/content-os/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: "h-1", choices: {} }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as {
      error: string;
      reasonCode?: string;
      fieldErrors?: Record<string, string[]>;
    };
    expect(json.reasonCode).toBe("INVALID_CATALOG_DEFINITION");
    expect(Object.keys(json.fieldErrors ?? {})).toEqual([FIELD]);
    expect(json.error).toContain('"content-os"');
  });

  it("a request the door's schema refuses is the Hub's 400 naming the field", async () => {
    const res = await app().request("/package-updates/content-os/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ choices: {} }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as {
      error: string;
      fieldErrors?: Record<string, string[]>;
    };
    expect(Object.keys(json.fieldErrors ?? {})).toEqual(["expectedVersion"]);
    // One sentence, never zod's JSON dump of the issues.
    expect(json.error.startsWith("expectedVersion:")).toBe(true);
    expect(m.apply).not.toHaveBeenCalled();
  });
});

/**
 * X2 root cause — `GET /capabilities/actions?limit=N` must cap ACTIONS, never
 * the raw registry list.
 *
 * Live (2026-09-14, Builder workspace): no limit → 57 actions (all 33 Synap
 * Core verbs present); `limit=100` → 2; `limit=20` (Raycast's default) → 0.
 * The registry list leads with ~90 catalog-only IS-native rows and unapproved
 * tools, which the projection drops, so slicing before projecting emptied the
 * answer — and Raycast then re-derived "catalog-ready but not executable" packs
 * from that false empty.
 *
 * Drives the real route + real `projectRunnableActions`; only the registry read
 * and the acting-context resolution are stubbed. The fixture puts catalog-only
 * rows FIRST — the one ordering where "slice raw" and "cap actions" disagree.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it, vi } from "vitest";
import type { RegistryCapability } from "../../../services/capabilities/capability-registry.js";

const WS = "0aaaaaaa-0000-4000-8000-000000000001";

const { listCapabilities } = vi.hoisted(() => ({
  listCapabilities: vi.fn(),
}));

vi.mock(
  "../../../services/capabilities/capability-registry.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../services/capabilities/capability-registry.js")
    >()),
    listCapabilities,
  })
);

vi.mock("./_shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_shared.js")>();
  return {
    ...actual,
    resolveActingContext: vi.fn(async () => ({
      ok: true,
      workspaceId: WS,
      userId: "user-1",
    })),
  };
});

const { registerCapabilitiesActionsRoutes } =
  await import("./capabilities-actions.js");

function row(partial: Partial<RegistryCapability> & { id: string }) {
  return {
    kind: "skill",
    name: partial.id,
    description: null,
    inputSchema: {},
    executor: "is-agent",
    governance: "auto",
    runnable: true,
    ...partial,
  } as RegistryCapability;
}

const CATALOG: RegistryCapability[] = [
  ...Array.from({ length: 30 }, (_, i) =>
    row({ id: `is-native:t${i}`, kind: "builtin-tool", catalogOnly: true })
  ),
  row({ id: "channel.create" }),
  row({ id: "feed.post" }),
  row({ id: "entity.query" }),
];

function app() {
  const a = new OpenAPIHono();
  a.use("*", async (c, next) => {
    c.set("scopes" as never, ["hub-protocol.read"] as never);
    await next();
  });
  registerCapabilitiesActionsRoutes(a as never);
  return a;
}

async function labels(qs: string): Promise<string[]> {
  // Honour `limit` exactly as the real registry does (a number slices the RAW
  // list; `null`/absent does not) — without this the stub would hide the bug.
  listCapabilities.mockImplementation(
    async (_ctx: unknown, opts?: { limit?: number | null }) =>
      typeof opts?.limit === "number" ? CATALOG.slice(0, opts.limit) : CATALOG
  );
  const res = await app().request(
    `/capabilities/actions?workspaceId=${WS}${qs}`
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { actions: Array<{ label: string }> };
  return body.actions.map((a) => a.label);
}

describe("GET /capabilities/actions — limit caps actions, not the raw registry", () => {
  it("no limit → every runnable action", async () => {
    expect(await labels("")).toEqual([
      "channel.create",
      "feed.post",
      "entity.query",
    ]);
  });

  it("limit=2 → the first 2 ACTIONS, even though the raw list leads with 30 catalog-only rows", async () => {
    expect(await labels("&limit=2")).toEqual(["channel.create", "feed.post"]);
  });

  it("the registry is read unsliced whenever a limit is given", async () => {
    listCapabilities.mockClear();
    await labels("&limit=2&query=channel");
    const opts = listCapabilities.mock.calls[0]?.[1] as { limit?: unknown };
    expect(opts.limit).toBeNull();
  });
});

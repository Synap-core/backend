/**
 * `GET /setup/status` is PUBLIC (auth-skipped: the CLI, eve and the setup page
 * read it before anyone can sign in), so its body may carry only what such a
 * client needs: `needsSetup`, `hasAdmin`, and the pod-admin invariant's
 * `healthy` + `kind`.
 *
 * THE DEFECT (pre-launch audit F3, 2026-10-28, verified live): the body
 * carried `podAdminInvariant.reason`, which read "pod-admin owned by <the
 * owner's email>", plus the workspace count. Pod hostnames are public
 * (Certificate Transparency), so a script harvested every customer's email.
 * Broken states leaked internal ids and raw database error text the same way.
 *
 * Through the REAL route. Mocked: the Kratos identity probe and the db reads.
 * Negative control: restore the old body (`podAdminInvariant: invariant`,
 * `workspaceCount`) and every case here fails.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER_EMAIL = "owner.private@example.test";
const OWNER_ID = "0aaaaaaa-0000-4000-8000-0000000000aa";
const WS_ID = "0bbbbbbb-0000-4000-8000-0000000000bb";

const h = vi.hoisted(() => ({
  podAdminWs: null as null | { id: string } | Error,
  owner: null as null | { userId: string },
  userRow: null as null | { id: string; email: string },
}));

vi.mock("@synap/auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  kratosAdmin: {
    listIdentities: async () => ({ data: [{ id: "kratos-1" }] }),
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({ where: async () => [{ count: 1 }] }),
      }),
      query: {
        workspaces: {
          findFirst: async () => {
            if (h.podAdminWs instanceof Error) throw h.podAdminWs;
            return h.podAdminWs;
          },
        },
        workspaceMembers: { findFirst: async () => h.owner },
        users: { findFirst: async () => h.userRow },
      },
    },
  };
});

const { registerSetupRoutes } = await import("./setup.js");

async function status(): Promise<{
  raw: string;
  body: Record<string, unknown>;
}> {
  const app = new OpenAPIHono();
  registerSetupRoutes(app as never);
  const res = await app.request("/setup/status");
  expect(res.status).toBe(200);
  const raw = await res.text();
  return { raw, body: JSON.parse(raw) };
}

beforeEach(() => {
  h.podAdminWs = { id: WS_ID };
  h.owner = { userId: OWNER_ID };
  h.userRow = { id: OWNER_ID, email: OWNER_EMAIL };
});

describe("GET /setup/status — a public body names nobody", () => {
  it("a healthy pod: no owner email, no count, only the fields a client needs", async () => {
    const { raw, body } = await status();
    expect(raw).not.toContain(OWNER_EMAIL);
    expect(body).toEqual({
      hasAdmin: true,
      needsSetup: false,
      podAdminInvariant: { healthy: true, kind: "ok" },
    });
  });

  it("an orphan owner row: the kind, never the user id", async () => {
    h.userRow = null;
    const { raw, body } = await status();
    expect(raw).not.toContain(OWNER_ID);
    expect(body.podAdminInvariant).toEqual({
      healthy: false,
      kind: "broken_orphan_member",
    });
  });

  it("no owner: the kind, never the workspace id", async () => {
    h.owner = null;
    const { raw, body } = await status();
    expect(raw).not.toContain(WS_ID);
    expect(body.podAdminInvariant).toEqual({
      healthy: false,
      kind: "broken_no_owner",
    });
  });

  it("a failed probe: the kind, never the database error text", async () => {
    h.podAdminWs = new Error(
      "connect ECONNREFUSED 10.0.4.7:5432 (db-internal)"
    );
    const { raw, body } = await status();
    expect(raw).not.toContain("10.0.4.7");
    expect(body.podAdminInvariant).toEqual({
      healthy: false,
      kind: "probe_failed",
    });
  });
});

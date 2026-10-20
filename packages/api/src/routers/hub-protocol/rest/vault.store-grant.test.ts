/**
 * S4 (founder, 2026-10-20) — `POST /vault/secrets` checks the key's GRANT the
 * same way its tRPC twin `secretsVault.create` does (`assertKeyMayWrite`
 * `secret` + `create` → grant key `secret.create`). It used to write with no
 * grant check at all, so a key limited to reading Notes could still plant a
 * credential in the vault.
 *
 * Agents keep storing a credential they already hold (the door's purpose, and
 * the `synap cap connect` fallback): the AI preset now carries `secret.create`
 * (never `vault.read`), so an agent minted with it is NOT refused.
 *
 * Rows rule out: a door that ignores the grant (the read-only row inserts), a
 * door that refuses every key (the CONTROL rows), a check that drops the
 * workspace (the pinned rows), and a preset that lost the verb.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AI_READ_PROPOSE_ROLE_ID,
  GRANT_PRESETS,
} from "@synap-core/types/grants";

const HUMAN = "11111111-1111-4111-8111-111111111111";
const WS = "66666666-6666-4666-8666-666666666666";
const OTHER_WS = "77777777-7777-4777-8777-777777777777";

const h = vi.hoisted(() => ({
  inserts: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    encryptServerSide: () => ({ encryptedData: "x", iv: "y", authTag: "z" }),
    db: {
      insert: vi.fn(() => ({
        values: (v: Record<string, unknown>) => {
          h.inserts.push(v);
          return {
            returning: async () => [{ id: "s-1", name: v.name, type: v.type }],
          };
        },
      })),
    },
  };
});

vi.mock("./_shared.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveActingContext: async () => ({
    ok: true,
    userId: HUMAN,
    workspaceId: WS,
  }),
}));

const { runWithGrant } = await import("@synap/database");
const { registerVaultRoutes } = await import("./vault.js");
import type { HubHono, HubVariables } from "./_shared.js";

type Scope = {
  permissions: readonly string[];
  workspaceIds?: readonly string[];
};

function store(scope: Scope | null) {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    c.set("userId", HUMAN);
    return scope
      ? runWithGrant({ scopes: [scope], clientId: null } as never, () => next())
      : next();
  });
  registerVaultRoutes(app);
  return app.request("/vault/secrets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Stripe", value: "sk_test", workspaceId: WS }),
  });
}

const AI_PRESET = GRANT_PRESETS.find((r) => r.id === AI_READ_PROPOSE_ROLE_ID)!
  .grant.permissions;

beforeEach(() => {
  h.inserts.length = 0;
});

describe("POST /vault/secrets checks the key's grant (S4)", () => {
  it("a key that may only read Notes is refused, and nothing is stored", async () => {
    const res = await store({ permissions: ["entity.note.read"] });
    expect(res.status).toBe(403);
    expect(h.inserts).toHaveLength(0);
  });

  it("a `secret.create` key pinned to ANOTHER workspace is refused", async () => {
    const res = await store({
      permissions: ["secret.create"],
      workspaceIds: [OTHER_WS],
    });
    expect(res.status).toBe(403);
    expect(h.inserts).toHaveLength(0);
  });

  it("CONTROL — `secret.create` in the secret's own workspace stores it", async () => {
    const res = await store({
      permissions: ["secret.create"],
      workspaceIds: [WS],
    });
    expect(res.status).toBe(200);
    expect(h.inserts.length).toBeGreaterThan(0);
  });

  it("CONTROL — an agent holding the AI preset still stores what it holds", async () => {
    const res = await store({ permissions: AI_PRESET });
    expect(res.status).toBe(200);
  });

  it("CONTROL — full access and a signed-in session (no grant) store it", async () => {
    expect((await store({ permissions: ["*"] })).status).toBe(200);
    expect((await store(null)).status).toBe(200);
  });
});

/**
 * The tRPC audit log never carries a credential (CP ticket 84f82ed3).
 *
 * It kept its own exact-match key list, so `secretsVault.create`'s typed
 * secret (`input.value`) and every compound key (`clientSecret`, `githubToken`)
 * were logged in plaintext. It now calls the pod's one log redactor
 * (`redactPayloadForLog`, `utils/redact-secrets.ts`).
 *
 * Driven from the seam: a real tRPC router built on the real `t`, with the real
 * `auditLogMiddleware`, called at the REAL procedure paths of the secret-bearing
 * doors with their real input shapes. What is asserted is the audit line the
 * logger received, so a middleware that stops calling the redactor, or passes
 * it the wrong path, goes red here.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

const h = vi.hoisted(() => ({
  lines: [] as Array<{ obj: Record<string, unknown>; msg: string }>,
}));

vi.mock("@synap-core/core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@synap-core/core")>();
  const log = {
    info(obj: Record<string, unknown>, msg: string) {
      h.lines.push({ obj, msg });
    },
    warn() {},
    error() {},
    debug() {},
  };
  return { ...real, createLogger: () => log };
});

const { t } = await import("../init-trpc.js");
const { auditLogMiddleware } = await import("./audit-log.js");

const SECRET = "hunter2-S3cr3tValue-9f8e7d";

const door = t.procedure
  .use(auditLogMiddleware)
  .input(z.unknown())
  .mutation(() => "ok");

/** The real router keys of the doors under test (`root.ts`). */
const router = t.router({
  secretsVault: t.router({ create: door, update: door }),
  capabilities: t.router({ credentials: t.router({ add: door }) }),
  adminSourceConfigs: t.router({ create: door }),
  aiProviderCredentials: t.router({ create: door }),
  devplane: t.router({ setProviderKey: door, saveEntitySecret: door }),
  mcpServers: t.router({ create: door }),
  tools: t.router({ setAuthBinding: door }),
  capture: t.router({ answer: door }),
  entities: t.router({ update: door }),
  guidelines: t.router({ set: door }),
  agents: t.router({ update: door }),
  automations: t.router({ update: door }),
  webhooks: t.router({ create: door }),
});

const caller = router.createCaller({
  userId: "u1",
  workspaceId: "w1",
} as never);

/** Call a door and return the audit line it wrote, serialized. */
async function audited(
  call: (c: typeof caller) => Promise<unknown>
): Promise<string> {
  h.lines.length = 0;
  await call(caller);
  const audit = h.lines.filter((l) => l.msg.startsWith("AUDIT: "));
  expect(audit).toHaveLength(1);
  return JSON.stringify(audit[0]!.obj.input);
}

beforeEach(() => {
  h.lines.length = 0;
});

describe("a secret under a neutral `value` key at a credential door", () => {
  it("secretsVault.create: the typed secret never reaches the log", async () => {
    const out = await audited((c) =>
      c.secretsVault.create({
        name: "Stripe live key",
        type: "api_key",
        value: SECRET,
        workspaceId: "11111111-1111-4111-8111-111111111111",
      })
    );
    expect(out).not.toContain(SECRET);
    expect(out).toContain("Stripe live key");
    expect(out).toContain("11111111-1111-4111-8111-111111111111");
  });

  it("secretsVault.update with an object secret is redacted whole", async () => {
    const out = await audited((c) =>
      c.secretsVault.update({
        id: "22222222-2222-4222-8222-222222222222",
        value: { username: "ops-user", pin: SECRET },
      })
    );
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("ops-user");
    expect(out).toContain("22222222-2222-4222-8222-222222222222");
  });

  it("capabilities.credentials.add: the credential value is redacted", async () => {
    const out = await audited((c) =>
      c.capabilities.credentials.add({
        capabilityId: "33333333-3333-4333-8333-333333333333",
        label: "Work account",
        value: SECRET,
      })
    );
    expect(out).not.toContain(SECRET);
    expect(out).toContain("Work account");
  });

  it("adminSourceConfigs.create: an inlineSecrets entry is redacted", async () => {
    const out = await audited((c) =>
      c.adminSourceConfigs.create({
        name: "Warehouse",
        inlineSecrets: [{ field: "auth.password", value: SECRET }],
      })
    );
    expect(out).not.toContain(SECRET);
    expect(out).toContain("Warehouse");
  });
});

describe("provider keys and tokens, through the one key rule", () => {
  it("a provider API key (aiProviderCredentials, devplane)", async () => {
    for (const call of [
      (c: typeof caller) =>
        c.aiProviderCredentials.create({ provider: "openai", apiKey: SECRET }),
      (c: typeof caller) =>
        c.devplane.setProviderKey({
          providerType: "anthropic",
          apiKey: SECRET,
        }),
      (c: typeof caller) =>
        c.devplane.saveEntitySecret({
          entityId: "44444444-4444-4444-8444-444444444444",
          propertySlug: "githubTokenVaultRef",
          secretValue: SECRET,
        }),
    ]) {
      const out = await audited(call);
      expect(out).not.toContain(SECRET);
    }
  });

  it("compound and nested keys are redacted, ids are kept", async () => {
    const out = await audited((c) =>
      c.tools.setAuthBinding({
        toolId: "t1",
        secretId: "55555555-5555-4555-8555-555555555555",
        config: {
          oauth: { clientSecret: SECRET, refresh_token: SECRET },
          headers: { Authorization: `Bearer ${SECRET}`, "X-Api-Key": SECRET },
        },
        private_key: SECRET,
        apiKeys: [SECRET, SECRET],
      })
    );
    expect(out).not.toContain(SECRET);
    expect(out).toContain('"toolId":"t1"');
    expect(out).toContain("55555555-5555-4555-8555-555555555555");
  });

  it("an MCP server's env map is redacted whatever its names", async () => {
    const out = await audited((c) =>
      c.mcpServers.create({
        slug: "notion",
        env: { NOTION_KEY: SECRET, DB_PASS: SECRET },
      })
    );
    expect(out).not.toContain(SECRET);
    expect(out).toContain('"slug":"notion"');
  });

  it("a webhook signing secret", async () => {
    const out = await audited((c) =>
      c.webhooks.create({
        name: "n8n",
        url: "https://x.example/h",
        secret: SECRET,
      })
    );
    expect(out).not.toContain(SECRET);
    expect(out).toContain("https://x.example/h");
  });

  it("a tagged form secret is redacted by its shape", async () => {
    const out = await audited((c) =>
      c.capture.answer({
        values: { field1: { kind: "new", value: SECRET } },
      })
    );
    expect(out).not.toContain(SECRET);
  });

  it("a credential pasted inside free text is scrubbed", async () => {
    const out = await audited((c) =>
      c.entities.update({
        description: `curl -H "Authorization: Bearer ${SECRET}" and {"api_key":"${SECRET}"}`,
      })
    );
    expect(out).not.toContain(SECRET);
  });

  it("a long string is redacted BEFORE it is cut", async () => {
    const out = await audited((c) =>
      c.entities.update({
        description: `${"x".repeat(450)} {"password":"${SECRET}${"y".repeat(200)}"}`,
      })
    );
    expect(out).not.toContain(SECRET.slice(0, 12));
  });
});

describe("what must stay readable", () => {
  it("a `value` outside any credential door is kept", async () => {
    const out = await audited((c) =>
      c.guidelines.set({ key: "tone", value: "warm" })
    );
    expect(out).toContain('"value":"warm"');
  });

  it("a number under a token-like key is kept", async () => {
    const out = await audited((c) => c.agents.update({ maxTokens: 1000 }));
    expect(out).toContain('"maxTokens":1000');
  });

  it("a vault reference is kept (a pointer, not a credential)", async () => {
    const out = await audited((c) =>
      c.automations.update({ token: "vault://google/refresh" })
    );
    expect(out).toContain("vault://google/refresh");
  });
});

/**
 * `{{vault:<ref>}}` in a skill's CODE or a tool's CONFIG becomes the
 * `vault://<id>` of the secret the applier created for THAT template's own
 * `vault[]` entry.
 *
 * ── THE GAP ─────────────────────────────────────────────────────────────────
 * A code skill can only redeem a secret through `secrets.get('vault://<id>')`,
 * and the id does not exist until the applier creates the secret — so a
 * template could not hand its own skill its own secret. The applier rewrote
 * only tool / MCP `credentialRef`s. The Claude Managed Agents start verb needs
 * the read-only GitHub token to mount `github_repository` resources and had to
 * ship with the mount switched off.
 *
 * The db is stubbed at the DATABASE boundary (the egress-declaration pattern):
 * the REAL `skillsRouter` / `toolsRouter` callers run between the applier and
 * the write, so the assertions read what the row would actually hold.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const SECRET_ID = "8b3c4d5e-6f70-4b82-8c93-d4e5f6071823";

const h = vi.hoisted(() => ({
  inserted: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  updatedSets: [] as Record<string, unknown>[],
  existing: {
    secret: null as Record<string, unknown> | null,
    skill: null as Record<string, unknown> | null,
  },
  mockCheckPermissionOrPropose: vi.fn(),
}));

vi.mock("../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: h.mockCheckPermissionOrPropose,
  createPendingProposal: vi.fn(),
}));
vi.mock("../../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: vi.fn(async () => undefined),
}));
vi.mock("./cp-template-client.js", () => ({
  fetchCPCapabilityTemplate: vi.fn(async () => null),
}));
vi.mock("../links/links-service.js", () => ({
  createLinks: vi.fn(async () => []),
  getLinksFor: vi.fn(async () => []),
  deleteLink: vi.fn(async () => undefined),
}));
vi.mock("../../routers/capability-containers.js", () => ({
  capabilityContainersRouter: {
    createCaller: () => ({
      create: vi.fn(async () => ({ capability: { id: "cap-1" } })),
      addPart: vi.fn(async () => ({ ok: true })),
    }),
  },
}));
vi.mock("../../utils/split-brain-service.js", () => ({
  isPodReadOnly: async () => false,
  getSyncGenerationState: async () => ({ generation: 1, isPrimary: true }),
  invalidateSyncGenerationCache: vi.fn(),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../../utils/audit-log.js", () => ({ auditLog: vi.fn() }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const schema = await import("@synap/database/schema");
  const rowsFor = (table: unknown): unknown[] => {
    if (table === schema.secrets)
      return h.existing.secret ? [h.existing.secret] : [];
    if (table === schema.skills)
      return h.existing.skill ? [h.existing.skill] : [];
    return [];
  };
  const select = () => {
    let table: unknown;
    const chain = {
      from: (t: unknown) => {
        table = t;
        return chain;
      },
      where: () => chain,
      orderBy: () => chain,
      innerJoin: () => chain,
      leftJoin: () => chain,
      limit: async () => rowsFor(table),
      then: (resolve: (rows: unknown[]) => unknown) => resolve(rowsFor(table)),
    };
    return chain;
  };
  const updateChain = {
    set: (v: Record<string, unknown>) => {
      h.updatedSets.push(v);
      return updateChain;
    },
    where: async () => undefined,
  };
  let n = 0;
  return {
    ...actual,
    encryptServerSide: vi.fn(() => ({
      encryptedData: "enc",
      iv: "iv",
      authTag: "tag",
    })),
    db: {
      select,
      update: () => updateChain,
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) => {
          h.inserted.push({ table, values });
          const id =
            table === schema.secrets
              ? SECRET_ID
              : `9c4d5e6f-7081-4c93-9da4-${String(++n).padStart(12, "0")}`;
          const returned = {
            returning: async () => [{ ...values, id }],
            onConflictDoNothing: () => returned,
            onConflictDoUpdate: () => returned,
            then: (resolve: (v: unknown) => unknown) => resolve(undefined),
          };
          return returned;
        },
      }),
      query: { skills: { findFirst: async () => h.existing.skill } },
    },
  };
});

import { createCapabilityFromDefinition } from "./create-from-definition.js";
import { skills, tools } from "@synap/database/schema";

const WS = "6f1c2a3b-4d5e-4f60-8a71-b2c3d4e5f601";
const UID = "7a2b3c4d-5e6f-4a71-9b82-c3d4e5f60712";

const CODE =
  "const ref = '{{vault:githubTokenSecret}}';\n" +
  "return { token: await secrets.get(ref), agent: '{{agentId}}' };";

const DEF = {
  key: "vault-ph",
  name: "Vault placeholder",
  params: [{ name: "githubToken", required: true }, { name: "agentId" }],
  vault: [
    {
      ref: "githubTokenSecret",
      name: "{{name}} GitHub token",
      value: "{{githubToken}}",
      type: "api_key",
    },
  ],
  tools: [
    {
      name: "vendor_api",
      kind: "provider",
      executor: "is-agent",
      config: {
        baseUrl: "https://api.vendor.test",
        mountTokenRef: "{{vault:githubTokenSecret}}",
      },
    },
  ],
  skills: [
    {
      name: "vendor_start",
      kind: "code",
      scope: "workspace",
      description: "start",
      code: CODE,
    },
  ],
  playbooks: [],
};

const apply = (def: Record<string, unknown> = DEF) =>
  createCapabilityFromDefinition(
    def as never,
    { githubToken: "ghp_SECRET", agentId: "agent_1" },
    { userId: UID, workspaceId: WS, authenticated: true } as never
  );

const insertedInto = (table: unknown) =>
  h.inserted.filter((r) => r.table === table).map((r) => r.values);

describe("{{vault:<ref>}} → the template's own vault://<id>", () => {
  beforeEach(() => {
    h.inserted.length = 0;
    h.updatedSets.length = 0;
    h.existing.secret = null;
    h.existing.skill = null;
    h.mockCheckPermissionOrPropose.mockReset();
    h.mockCheckPermissionOrPropose.mockResolvedValue({ granted: true });
  });

  it("CREATE: the persisted skill code names the secret the applier just created", async () => {
    const out = await apply();
    expect(out.created.vault).toEqual([
      {
        ref: "githubTokenSecret",
        vaultRef: `vault://${SECRET_ID}`,
        secretId: SECRET_ID,
      },
    ]);
    const skill = insertedInto(skills).find((s) => s.name === "vendor_start");
    expect(
      skill,
      "no skills row was inserted — test wiring broken"
    ).toBeTruthy();
    expect(skill!.code).toContain(`'vault://${SECRET_ID}'`);
    expect(skill!.code).not.toContain("{{vault:");
    // Param interpolation is untouched by the vault pass.
    expect(skill!.code).toContain("'agent_1'");
    // The raw token never lands in code — only the reference to its secret.
    expect(skill!.code).not.toContain("ghp_SECRET");
  });

  it("CREATE: a tool's config gets the same reference", async () => {
    await apply();
    const tool = insertedInto(tools).find((t) => t.name === "vendor_api");
    expect(tool, "no tools row was inserted — test wiring broken").toBeTruthy();
    expect((tool!.config as Record<string, unknown>).mountTokenRef).toBe(
      `vault://${SECRET_ID}`
    );
  });

  it("a ref the template does not declare refuses the install BEFORE anything is written", async () => {
    // Another template's ref (or a typo) must never resolve — and must never
    // leave a placeholder that reads as a credential that is silently absent.
    const def = {
      ...DEF,
      skills: [
        {
          ...DEF.skills[0],
          code: "return secrets.get('{{vault:otherTemplatesSecret}}');",
        },
      ],
    };
    await expect(apply(def)).rejects.toThrow(
      /skill "vendor_start" code: \{\{vault:otherTemplatesSecret\}\} matches no vault\[\] entry/
    );
    expect(h.inserted, "the refusal must precede every write").toEqual([]);
  });

  it("RE-APPLY: the same secret is reused, the code is byte-identical, and an approved skill stays approved", async () => {
    h.existing.secret = { id: SECRET_ID };
    const resolved = CODE.replace(
      "{{vault:githubTokenSecret}}",
      `vault://${SECRET_ID}`
    ).replace("{{agentId}}", "agent_1");
    h.existing.skill = {
      id: "ad5e6f70-8192-4da4-8eb5-f60718293a4b",
      name: "vendor_start",
      kind: "code",
      code: resolved,
      providerSpec: null,
      parameters: undefined,
      description: "start",
      scope: "workspace",
      category: null,
      agentTypes: null,
      executionMode: "sync",
      timeoutSeconds: 30,
      body: null,
      approved: true,
      intent: null,
      metadata: {},
    };
    await apply();
    expect(
      insertedInto(skills),
      "a re-apply must not mint a second skill"
    ).toEqual([]);
    const set = h.updatedSets.find((s) => "code" in s && s.kind === "code");
    expect(set, "the applier's skills UPDATE never ran").toBeTruthy();
    expect(set!.code).toBe(resolved);
    expect(
      "approved" in set!,
      "an unchanged (re-resolved) code must not demote the approved skill"
    ).toBe(false);
  });
});

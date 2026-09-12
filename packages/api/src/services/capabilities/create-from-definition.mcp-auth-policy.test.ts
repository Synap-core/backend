import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Installing a template MCP server with `auth`, `toolPolicy`, and a `podWide`
 * vault key — what actually lands in the rows.
 *
 * The applier is where each of these can die quietly. It builds `mcp_servers`
 * and `secrets` values field by field, so a field the template declares but the
 * applier forgets is simply never written, and nothing complains.
 *
 * The db is stubbed at the DATABASE boundary (same pattern as
 * create-from-definition.egress-declaration.test.ts), so the assertions read the
 * values the real applier handed to `.values()` — not whether a helper was called.
 */

const { inserted, mockCheckPermissionOrPropose } = vi.hoisted(() => ({
  inserted: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  mockCheckPermissionOrPropose: vi.fn(),
}));

vi.mock("../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: mockCheckPermissionOrPropose,
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
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    orderBy: () => selectChain,
    innerJoin: () => selectChain,
    leftJoin: () => selectChain,
    limit: async () => [],
    then: (resolve: (rows: unknown[]) => unknown) => resolve([]),
  };
  const updateChain = {
    set: () => updateChain,
    where: async () => undefined,
  };
  let n = 0;
  return {
    ...actual,
    encryptServerSide: vi.fn(() => ({
      ciphertext: "enc",
      iv: "iv",
      tag: "tag",
    })),
    db: {
      select: () => selectChain,
      update: () => updateChain,
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) => {
          const id = `row-${++n}`;
          inserted.push({ table, values });
          const returned = {
            returning: async () => [{ ...values, id }],
            onConflictDoNothing: () => returned,
            onConflictDoUpdate: () => returned,
            then: (resolve: (v: unknown) => unknown) => resolve(undefined),
          };
          return returned;
        },
      }),
      query: { skills: { findFirst: async () => null } },
    },
  };
});

import { createCapabilityFromDefinition } from "./create-from-definition.js";
import { mcpServers, secrets } from "@synap/database/schema";

const UID = "22222222-2222-2222-2222-222222222222";
const WS = "11111111-1111-1111-1111-111111111111";

const mcpRow = () => inserted.find((r) => r.table === mcpServers)?.values;
const secretRow = () => inserted.find((r) => r.table === secrets)?.values;

function apply(def: Record<string, unknown>, workspaceId: string | null) {
  return createCapabilityFromDefinition(
    {
      key: "freellmapi",
      name: "FreeLLMAPI",
      tools: [],
      skills: [],
      playbooks: [],
      ...def,
    } as never,
    {},
    { userId: UID, workspaceId, authenticated: true } as never
  );
}

const SERVER = {
  slug: "freellmapi",
  name: "FreeLLMAPI",
  transport: "http",
  url: "https://llm.example.test/mcp",
  approved: true,
};

beforeEach(() => {
  inserted.length = 0;
  mockCheckPermissionOrPropose.mockReset();
  mockCheckPermissionOrPropose.mockResolvedValue({ granted: true });
});

describe("applier: MCP server auth, tool policy, pod-wide key", () => {
  it("REJECTS an auth.credentialRef that names no vault entry", async () => {
    // Storing it would install a server that 401s on every call with nothing
    // pointing at why.
    await expect(
      apply(
        {
          vault: [],
          mcpServers: [
            {
              ...SERVER,
              auth: { credentialRef: "noSuchRef", header: "Authorization" },
            },
          ],
        },
        WS
      )
    ).rejects.toThrow(/matches no vault\[\] entry/);
  });

  it("writes auth and toolPolicy onto the mcp_servers row", async () => {
    await apply(
      {
        vault: [],
        mcpServers: [
          {
            ...SERVER,
            auth: {
              credentialRef: "vault://existing-1",
              header: "Authorization",
              prefix: "Bearer ",
            },
            toolPolicy: { default: "governed", inline: ["list_models"] },
          },
        ],
      },
      WS
    );
    expect(mcpRow()).toMatchObject({
      slug: "freellmapi",
      auth: {
        credentialRef: "vault://existing-1",
        header: "Authorization",
        prefix: "Bearer ",
      },
      toolPolicy: { default: "governed", inline: ["list_models"] },
    });
  });

  it("rewrites a template-local ref to the created secret, pod-wide", async () => {
    await apply(
      {
        vault: [
          {
            ref: "unifiedKey",
            name: "key",
            value: "freellmapi-abc",
            type: "api_key",
            podWide: true,
          },
        ],
        mcpServers: [
          {
            ...SERVER,
            auth: { credentialRef: "unifiedKey", header: "Authorization" },
          },
        ],
      },
      null
    );
    expect(secretRow()).toMatchObject({ isPodWide: true });
    const ref = (mcpRow()?.auth as { credentialRef: string } | undefined)
      ?.credentialRef;
    expect(ref).toMatch(/^vault:\/\/.+/);
    expect(ref).not.toBe("vault://unifiedKey");
  });

  it("does NOT make a key pod-wide on a workspace install, whatever the template asks", async () => {
    // The discriminating pair for the case above: same template, workspace
    // scope. A rule honouring `podWide` alone would share a workspace's secret
    // pod-wide.
    await apply(
      {
        vault: [
          {
            ref: "unifiedKey",
            name: "key",
            value: "freellmapi-abc",
            type: "api_key",
            podWide: true,
          },
        ],
        mcpServers: [
          {
            ...SERVER,
            auth: { credentialRef: "unifiedKey", header: "Authorization" },
          },
        ],
      },
      WS
    );
    expect(secretRow()).toMatchObject({ isPodWide: false });
  });
});

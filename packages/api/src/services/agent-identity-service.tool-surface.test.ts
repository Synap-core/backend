/**
 * provisionSurfaceAgentKey — WHOSE key a re-mint inherits its MCP tool surface
 * from (`inheritToolSurface`, decision B1 d, 2026-10-21).
 *
 * The OAuth AS mints every direct client of one person as the SAME
 * `claude-web-direct` agent user. Inheriting from that agent's newest key made
 * a brand-new client (Raycast) list whatever claude.ai listed — a legacy key
 * lists every tool — instead of the 9-tool `entry` starter set.
 *
 * The query is driven through a tiny fake `api_keys` table that EVALUATES the
 * real `where` the door builds (eq/and are recorded, not stubbed to nothing), so
 * a scope the door forgets to apply shows up as the wrong inherited row.
 *
 * Rows that rule out a wrong rule:
 *   (a) instance scope, the agent has a legacy key on ANOTHER connection only →
 *       the new connection starts on `entry` (rules out agent-wide inheritance);
 *   (b) instance scope, this connection already has an entry key with groups →
 *       re-authorize keeps them (rules out "always entry");
 *   (c) default scope keeps the agent-wide rule (rules out widening the change
 *       to every CLI computer instance);
 *   (d) instance scope without an instanceId fails loudly.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Cond =
  | { op: "eq"; col: string; val: unknown }
  | { op: "and"; parts: Cond[] }
  | { op: "other" };

interface FakeKey {
  userId: string;
  keyType: string;
  instanceId: string | null;
  toolProfile: "entry" | "builder" | null;
  toolGroups: string[];
  createdAt: number;
}

let keys: FakeKey[] = [];
let lastMintInput: Record<string, unknown> | undefined;

function matches(row: FakeKey, cond: Cond | undefined): boolean {
  if (!cond) return true;
  if (cond.op === "and") return cond.parts.every((p) => matches(row, p));
  if (cond.op === "eq")
    return (row as unknown as Record<string, unknown>)[cond.col] === cond.val;
  throw new Error("fake api_keys: unsupported condition in the inherit read");
}

// The real module underneath (as agent-identity-service.podwide.test.ts):
// the door's import graph (agent-connect → permission-check → @synap/jobs)
// reads real tables at import time. Only the reads under test are faked.
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: {
    query: {
      users: {
        findFirst: vi.fn(async () => ({
          id: "agent-user-1",
          email: "agent-claude-web-direct@synap.agent",
        })),
      },
      apiKeys: {
        findFirst: vi.fn(async ({ where }: { where?: Cond }) => {
          const hit = keys
            .filter((k) => matches(k, where))
            .sort((a, b) => b.createdAt - a.createdAt)[0];
          return hit
            ? { toolProfile: hit.toolProfile, toolGroups: hit.toolGroups }
            : undefined;
        }),
      },
    },
  },
  eq: (col: string, val: unknown): Cond => ({ op: "eq", col, val }),
  and: (...parts: Array<Cond | undefined>): Cond => ({
    op: "and",
    parts: parts.filter((p): p is Cond => p !== undefined),
  }),
  inArray: () => ({ op: "other" }),
  isNull: () => ({ op: "other" }),
  sql: vi.fn(),
  apiKeys: {
    userId: "userId",
    keyType: "keyType",
    instanceId: "instanceId",
    isActive: "isActive",
    revokedAt: "revokedAt",
  },
  EventRepository: class {},
  ApiKeyRepository: class {},
}));

vi.mock("@synap/database/schema", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database/schema")>()),
  agents: {},
  users: {},
}));

vi.mock("./hub-integration-registration.js", () => ({
  SETUP_AGENT_HUB_SCOPES: ["hub-protocol.read", "hub-protocol.write"],
  AGENT_KEY_TTL_DAYS: 90,
  AGENT_KEY_ROTATION_LEAD_DAYS: 14,
  revokeActiveHubInboundKeysForUser: vi.fn(async () => undefined),
}));

vi.mock("./external-registration.js", () => ({
  createAndVerifyHubInboundKey: vi.fn(
    async (_repo: unknown, input: Record<string, unknown>) => {
      lastMintInput = input;
      return {
        outcome: "CONNECTED_VERIFIED",
        plainKey: "synap_hub_live_stub",
        apiKey: { id: "minted-key-id" },
      };
    }
  ),
}));

vi.mock("./key-grant.js", () => ({
  attachGrantOrRevoke: vi.fn(async () => undefined),
}));

import { provisionSurfaceAgentKey } from "./agent-identity-service.js";

const CLAUDE = "oauth:dcr_claude:human-1";
const RAYCAST = "oauth:dcr_raycast:human-1";

function key(over: Partial<FakeKey>): FakeKey {
  return {
    userId: "agent-user-1",
    keyType: "hub_inbound",
    instanceId: CLAUDE,
    toolProfile: null,
    toolGroups: [],
    createdAt: 1,
    ...over,
  };
}

const mint = (
  instanceId: string | undefined,
  inheritToolSurface?: "agent" | "instance"
) =>
  provisionSurfaceAgentKey({
    agentType: "claude-web-direct",
    createdByUserId: "human-1",
    linkedUserId: "human-1",
    ...(instanceId ? { instanceId } : {}),
    ...(inheritToolSurface ? { inheritToolSurface } : {}),
  });

describe("provisionSurfaceAgentKey — inheritToolSurface", () => {
  beforeEach(() => {
    keys = [];
    lastMintInput = undefined;
  });

  it("(a) a NEW connection of a shared agent starts on entry, whatever another connection lists", async () => {
    keys = [key({ instanceId: CLAUDE, toolProfile: null, createdAt: 5 })];
    await mint(RAYCAST, "instance");
    expect(lastMintInput?.toolProfile).toBe("entry");
  });

  it("(b) re-authorizing the SAME connection keeps its profile and unlocked groups", async () => {
    keys = [
      key({ instanceId: CLAUDE, toolProfile: null, createdAt: 9 }),
      key({
        instanceId: RAYCAST,
        toolProfile: "entry",
        toolGroups: ["data"],
        createdAt: 3,
      }),
    ];
    await mint(RAYCAST, "instance");
    expect(lastMintInput).toMatchObject({
      toolProfile: "entry",
      toolGroups: ["data"],
    });
  });

  it("(c) the default stays agent-wide: a new computer of a legacy agent stays legacy", async () => {
    keys = [key({ instanceId: "laptop", toolProfile: null, createdAt: 5 })];
    await mint("devbox");
    expect(lastMintInput?.toolProfile).toBeNull();
  });

  it("(d) instance scope without an instanceId fails loudly, never falls back to the agent", async () => {
    await expect(mint(undefined, "instance")).rejects.toThrow(/instanceId/);
    expect(lastMintInput).toBeUndefined();
  });
});

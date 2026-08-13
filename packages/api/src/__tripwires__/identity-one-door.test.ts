import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — API-key identity resolution has ONE door (`resolveKeyIdentity`).
 *
 * Every transport that authenticates an API key must derive the same three
 * identity facts the same way. Before consolidation the derivation was
 * copy-pasted at three sites as
 *
 *     agentUserId = keyRecord.linkedUserId ? keyRecord.userId : undefined
 *
 * which conflated "has a linked human" (DELEGATION) with "is an agent" (the fact
 * the governance membrane needs). The real is-agent signal is the key
 * principal's `users.userType === 'agent'`. `resolveKeyIdentity`
 * (access/key-identity.ts) is now the ONLY place that derivation lives.
 *
 * This test has two halves, mirroring `a2ai-one-door.test.ts`:
 *   1. STATIC (source-grep): the hand-rolled remap may appear ONLY in the
 *      resolver; all three transports import + call `resolveKeyIdentity`; and the
 *      MCP attribution reject gate keys on the AGENT signal, not `linkedUserId`.
 *   2. CONTRACT (runnable): the same keyRecord fixtures fed through the resolver
 *      derive the correct `{effectiveUserId, agentUserId, isAgent}` — the real
 *      proof the derivation is right.
 */

// ── The three transports that must delegate to the ONE door ────────────────────
const TRANSPORTS = [
  "src/middleware/api-key-auth.ts",
  "src/routers/hub-protocol-rest.ts",
  "src/routers/mcp/http-handler.ts",
];
// The ONE door.
const RESOLVER = "src/access/key-identity.ts";
// The exact hand-rolled agentUserId derivation the resolver replaces. It ties
// the acting-agent identity to the DELEGATION fact — the bug being retired.
const BANNED_REMAP = "linkedUserId ? keyRecord.userId";

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

describe("tripwire: API-key identity has one door (resolveKeyIdentity)", () => {
  it("each transport imports AND calls resolveKeyIdentity", () => {
    for (const rel of TRANSPORTS) {
      const src = read(rel);
      expect(
        src,
        `${rel} must import resolveKeyIdentity from the access door`
      ).toMatch(
        /import\s*\{[^}]*resolveKeyIdentity[^}]*\}\s*from\s*["'][^"']*access\/key-identity\.js["']/
      );
      expect(
        src,
        `${rel} must CALL resolveKeyIdentity(keyRecord) — not hand-roll the remap`
      ).toMatch(/resolveKeyIdentity\(keyRecord\)/);
    }
  });

  it("no transport hand-rolls the linkedUserId→agentUserId remap", () => {
    const offenders = TRANSPORTS.filter((rel) =>
      read(rel).includes(BANNED_REMAP)
    );
    expect(
      offenders,
      "the agent-identity derivation belongs ONLY in access/key-identity.ts. " +
        "Call resolveKeyIdentity(keyRecord) instead of hand-rolling it."
    ).toEqual([]);
  });

  it("the resolver keys agentUserId on the is-agent signal, not linkedUserId", () => {
    const src = read(RESOLVER);
    // The acting agent is derived from `isAgent`, never from "has a linked human".
    expect(src).toMatch(
      /agentUserId:\s*isAgent\s*\?\s*keyRecord\.userId\s*:\s*undefined/
    );
    // And `isAgent` itself is the principal's userType, not linkedUserId.
    expect(src).toMatch(/userType\s*===\s*["']agent["']/);
  });

  it("the MCP attribution reject gate keys on the agent signal (admits agents)", () => {
    const src = read("src/routers/mcp/http-handler.ts");
    const at = src.indexOf("function shouldRejectUnattributedWrite");
    expect(at).toBeGreaterThan(-1);
    // The bare-key predicate must AND in `!isAgent` — otherwise a legitimate
    // pod-wide agent (userType='agent', no linked human) is wrongly rejected.
    const body = src.slice(at, at + 900);
    expect(
      body,
      "shouldRejectUnattributedWrite must consult the is-agent signal so a real " +
        "agent principal is ADMITTED, not rejected as an unattributed write."
    ).toMatch(/!isAgent/);
  });
});

// ── CONTRACT: the derivation itself ────────────────────────────────────────────
// Mock the ONE users lookup the resolver performs. `db.query.users.findFirst`
// returns the principal's userType (or undefined for the "system" sentinel).
const { findFirstMock } = vi.hoisted(() => ({ findFirstMock: vi.fn() }));
vi.mock("@synap/database", () => ({
  db: { query: { users: { findFirst: findFirstMock } } },
  users: { id: "users.id", userType: "users.user_type" },
  eq: (a: unknown, b: unknown) => ({ a, b }),
}));

// Imported AFTER the mock (vi.mock is hoisted above imports by vitest).
import { resolveKeyIdentity } from "../access/key-identity.js";

describe("contract: resolveKeyIdentity derivation", () => {
  beforeEach(() => findFirstMock.mockReset());

  it("agent principal + linked human → human owns data, agent attributed", async () => {
    findFirstMock.mockResolvedValue({ userType: "agent" });
    expect(
      await resolveKeyIdentity({ userId: "agent-1", linkedUserId: "human-1" })
    ).toEqual({
      effectiveUserId: "human-1",
      agentUserId: "agent-1",
      isAgent: true,
    });
  });

  it("agent principal + NO linked human (pod-wide agent, #1b) → still attributed", async () => {
    findFirstMock.mockResolvedValue({ userType: "agent" });
    expect(
      await resolveKeyIdentity({ userId: "agent-1", linkedUserId: null })
    ).toEqual({
      effectiveUserId: "agent-1",
      agentUserId: "agent-1",
      isAgent: true,
    });
  });

  it("human principal (PAT) → owner is the user, no agent attribution", async () => {
    findFirstMock.mockResolvedValue({ userType: "human" });
    expect(
      await resolveKeyIdentity({ userId: "human-1", linkedUserId: null })
    ).toEqual({
      effectiveUserId: "human-1",
      agentUserId: undefined,
      isAgent: false,
    });
  });

  it("no users row (e.g. 'system' sentinel) → not an agent", async () => {
    findFirstMock.mockResolvedValue(undefined);
    expect(
      await resolveKeyIdentity({ userId: "system", linkedUserId: null })
    ).toEqual({
      effectiveUserId: "system",
      agentUserId: undefined,
      isAgent: false,
    });
  });
});

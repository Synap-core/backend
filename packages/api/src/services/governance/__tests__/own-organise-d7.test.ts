/**
 * D7 (founder, 2026-10-28) — the three door proofs the widening added
 * (`own-organise.ts`). `isOwnFreshWork` answers "yes" unless a test says
 * otherwise, so every `false` below is the DOOR's own rule:
 *   - Q2: its own `blocked_by` edge, on a session bound to THIS key;
 *   - own renames: a re-type that keeps the entity scope;
 *   - Q3: a decision carrying the relay provenance, from a session of THIS
 *     key and THIS person.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  key: "key-1" as string | undefined,
  fresh: vi.fn(async (_db: unknown, _input: unknown) => true),
  /** Rows the fake db answers, per table name. */
  rows: {} as Record<string, unknown[]>,
  scopes: {} as Record<string, string>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const { getTableName } = await import("drizzle-orm");
  const chain = (table: unknown) => {
    const rows = async () => h.rows[getTableName(table as never)] ?? [];
    const q = {
      where: () => q,
      limit: rows,
      then: (res: (v: unknown[]) => unknown) => rows().then(res),
    };
    return q;
  };
  return {
    ...actual,
    db: { select: () => ({ from: chain }) },
    getRequestApiKeyId: () => h.key,
    isOwnFreshWork: h.fresh,
    ProfileResolutionService: class {
      async getEntityScope(slug: string) {
        return h.scopes[slug] ?? "workspace";
      }
    },
  };
});
vi.mock("../../agent-identity-service.js", () => ({
  getAgentFocusProjectId: async () => null,
}));

import {
  ownWorkOrganiseForBlockerRemoval,
  ownWorkOrganiseForRelayedDecision,
  ownWorkOrganiseForRetype,
  relayedDecisionSession,
} from "../own-organise.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ownSession = (over: Record<string, unknown> = {}) => ({
  userId: "person-1",
  metadata: { clientKey: "key:key-1|conv:c" },
  ...over,
});

beforeEach(() => {
  h.key = "key-1";
  h.fresh.mockReset();
  h.fresh.mockImplementation(async () => true);
  h.rows = {};
  h.scopes = {};
});

describe("Q2 — removing its own blocked_by edge", () => {
  const edge = (over: Record<string, unknown> = {}) => ({
    fromType: "session",
    fromId: SESSION,
    toType: "session",
    toId: OTHER,
    linkType: "blocked_by",
    ...over,
  });
  const remove = (over: Record<string, unknown> = {}) =>
    ownWorkOrganiseForBlockerRemoval({
      agentUserId: "agent-1",
      edge: edge(over) as never,
    });

  it("its own session's fresh edge → the proof, checked on the LINK", async () => {
    h.rows = { focus_sessions: [ownSession()], links: [{ id: "link-1" }] };
    expect(await remove()).toBe(true);
    expect(h.fresh).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ subjectType: "link", subjectIds: ["link-1"] })
    );
  });

  it("another key's session, another link type, a non-session end, no key, no such edge, an old edge → no proof", async () => {
    h.rows = { focus_sessions: [ownSession()], links: [{ id: "link-1" }] };
    expect(await remove({ linkType: "replaces" })).toBe(false);
    expect(await remove({ fromType: "entity" })).toBe(false);
    h.key = undefined;
    expect(await remove()).toBe(false);
    h.key = "key-1";
    h.rows.focus_sessions = [
      ownSession({ metadata: { clientKey: "key:key-2" } }),
    ];
    expect(await remove()).toBe(false);
    h.rows = { focus_sessions: [ownSession()], links: [] };
    expect(await remove()).toBe(false);
    h.rows = { focus_sessions: [ownSession()], links: [{ id: "link-1" }] };
    h.fresh.mockImplementation(async () => false);
    expect(await remove()).toBe(false);
  });
});

describe("own renames — re-typing its own fresh record", () => {
  const retype = (over: Record<string, unknown> = {}) =>
    ownWorkOrganiseForRetype({
      agentUserId: "agent-1",
      entityId: "e-1",
      fromKind: "issue",
      toKind: "finding",
      workspaceId: "ws-1",
      ...over,
    });

  it("same scope, its own fresh record → the proof", async () => {
    expect(await retype()).toBe(true);
    expect(h.fresh).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ subjectType: "entity", subjectIds: ["e-1"] })
    );
  });

  it("a re-type that changes who sees it (workspace ↔ pod) stays a floor", async () => {
    h.scopes = { finding: "pod" };
    expect(await retype()).toBe(false);
    expect(h.fresh).not.toHaveBeenCalled();
  });

  it("no kind change, no key, or not its own fresh record → no proof", async () => {
    expect(await retype({ toKind: "issue" })).toBe(false);
    expect(await retype({ fromKind: null })).toBe(false);
    h.key = undefined;
    expect(await retype()).toBe(false);
    h.key = "key-1";
    h.fresh.mockImplementation(async () => false);
    expect(await retype()).toBe(false);
  });
});

describe("Q3 — a decision the person made in chat", () => {
  const relayed = {
    answeredVia: "relayed",
    relayQuote: "Yes, ship the budget at 5.",
    sourceSessionId: SESSION,
  };

  it("relayedDecisionSession: all three provenance fields on a decision, or nothing", () => {
    expect(relayedDecisionSession("decision", relayed)).toBe(SESSION);
    expect(relayedDecisionSession("note", relayed)).toBeNull();
    expect(
      relayedDecisionSession("decision", { ...relayed, answeredVia: "tap" })
    ).toBeNull();
    expect(
      relayedDecisionSession("decision", { ...relayed, relayQuote: "  " })
    ).toBeNull();
    expect(
      relayedDecisionSession("decision", {
        ...relayed,
        sourceSessionId: undefined,
      })
    ).toBeNull();
    expect(relayedDecisionSession("decision", null)).toBeNull();
  });

  const record = (over: Record<string, unknown> = {}) =>
    ownWorkOrganiseForRelayedDecision({
      agentUserId: "agent-1",
      userId: "person-1",
      profileSlug: "decision",
      properties: relayed,
      ...over,
    });

  it("from a session of THIS key and THIS person → the proof", async () => {
    h.rows = { focus_sessions: [ownSession()] };
    expect(await record()).toBe(true);
  });

  it("another person's session, another key's session, a malformed session id, no key → no proof", async () => {
    h.rows = { focus_sessions: [ownSession({ userId: "person-2" })] };
    expect(await record()).toBe(false);
    h.rows = {
      focus_sessions: [ownSession({ metadata: { clientKey: "key:key-9" } })],
    };
    expect(await record()).toBe(false);
    h.rows = { focus_sessions: [ownSession()] };
    expect(
      await record({ properties: { ...relayed, sourceSessionId: "nope" } })
    ).toBe(false);
    h.key = undefined;
    expect(await record()).toBe(false);
  });
});

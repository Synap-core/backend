/**
 * resolveHolderAccess — one reading of what an agent, an app or a key may do.
 * Each row names the wrong rule it rules out.
 */
import { describe, expect, it } from "vitest";
import { resolveObjectNounPlural } from "../vocabulary/index.js";
import {
  agentCapabilitiesToDraft,
  GRANT_FULL_ACCESS_SENTENCE,
  HOLDER_EVERYTHING,
  HOLDER_NO_ACCESS_SENTENCE,
  HOLDER_NOTHING,
  KEY_ACCESS_ENDED_SENTENCE,
  KEY_ACCESS_UNGRANTED_SENTENCE,
  narrowRequestsToRead,
  resolveHolderAccess,
  type HolderAccessInput,
  type KeyAccessGrant,
} from "./index.js";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const FUTURE = "2027-01-12T00:00:00Z";
const PAST = "2026-01-01T00:00:00Z";

const grant = (
  permissions: string[],
  extra: Partial<KeyAccessGrant> = {}
): KeyAccessGrant => ({ permissions, expiresAt: null, ...extra });

const key = (
  limits: HolderAccessInput["limits"],
  extra: Partial<HolderAccessInput> = {}
) =>
  resolveHolderAccess({ kind: "key", name: "CLI", limits, now: NOW, ...extra });

const agent = (
  capabilities: string[] | null,
  extra: Partial<HolderAccessInput> = {}
) =>
  resolveHolderAccess({
    kind: "agent",
    name: "Claude",
    limits: { source: "capabilities", capabilities },
    now: NOW,
    ...extra,
  });

const NOTES = resolveObjectNounPlural("note");
const PROPOSALS = resolveObjectNounPlural("proposal");

describe("resolveHolderAccess — keys", () => {
  // Rules out: an ungranted key read as "no grant ⇒ no access".
  it("an ungranted key is full, in the one ungranted wording", () => {
    const h = key({ source: "grants", access: "ungranted", grants: [] });
    expect(h.state).toBe("full");
    expect(h.danger.full).toBe(true);
    expect(h.sentence).toBe(`${KEY_ACCESS_UNGRANTED_SENTENCE}.`);
    expect(h.tiers).toEqual({
      read: HOLDER_EVERYTHING,
      change: HOLDER_EVERYTHING,
      approve: HOLDER_EVERYTHING,
    });
    expect(h.posture).toBeNull();
  });

  // Rules out: `ended` folded into `ungranted` (both have zero grants).
  it("an ended key may touch nothing", () => {
    const h = key({ source: "grants", access: "ended", grants: [] });
    expect(h.state).toBe("ended");
    expect(h.sentence).toBe(KEY_ACCESS_ENDED_SENTENCE);
    expect(h.tiers).toEqual({
      read: HOLDER_NOTHING,
      change: null,
      approve: null,
    });
    expect(h.danger).toEqual({ full: false, approves: false, deletes: false });
    expect(h.draft).toBeNull();
  });

  // Rules out: a revoked or expired key still read by its grants.
  it("a revoked or expired key is ended whatever its grants say", () => {
    const limits = {
      source: "grants" as const,
      access: "granted" as const,
      grants: [grant(["*"])],
    };
    expect(key(limits, { revokedAt: PAST }).state).toBe("ended");
    const expired = key(limits, { expiresAt: PAST });
    expect(expired.state).toBe("ended");
    expect(expired.lifetime.expired).toBe(true);
    expect(key(limits, { expiresAt: FUTURE }).state).toBe("full");
  });

  it("a granted key: tiers, sentence, lifetime and its one grant as the draft", () => {
    const h = key(
      {
        source: "grants",
        access: "granted",
        grants: [grant(["entity.note"], { workspaceIds: ["ws-sales"] })],
      },
      { expiresAt: FUTURE, workspaceNames: { "ws-sales": "Sales" } }
    );
    expect(h.state).toBe("limited");
    expect(h.tiers.read).toBe(NOTES);
    expect(h.tiers.change).toBe(NOTES);
    expect(h.tiers.approve).toBeNull();
    // A bare kind covers delete.
    expect(h.danger).toEqual({ full: false, approves: false, deletes: true });
    expect(h.sentence).toBe(`Reads ${NOTES}, changes ${NOTES} in Sales.`);
    expect(h.where).toEqual({
      anywhere: false,
      spaces: [{ id: "ws-sales", name: "Sales" }],
      projectCount: 0,
    });
    expect(h.lifetime.when).toBe("Until 12 Jan 2027");
    expect(h.draft).toEqual({
      permissions: ["entity.note"],
      workspaceIds: ["ws-sales"],
    });
    expect(h.lines).toHaveLength(1);
  });

  // Rules out: a bare subject read as approving (the pre-20c34bb6 grammar).
  it("a bare proposal subject does not approve; a named proposal.approve does", () => {
    const bare = key({
      source: "grants",
      access: "granted",
      grants: [grant(["proposal"])],
    });
    expect(bare.tiers.approve).toBeNull();
    expect(bare.danger.approves).toBe(false);
    const named = key({
      source: "grants",
      access: "granted",
      grants: [grant(["proposal.approve"])],
    });
    expect(named.tiers.approve).toBe(PROPOSALS);
    expect(named.danger.approves).toBe(true);
    expect(named.danger.full).toBe(false);
    expect(named.sentence).toBe(`Reads nothing, approves ${PROPOSALS}.`);
  });

  it("`*` is full, approving included, in red", () => {
    const h = key({
      source: "grants",
      access: "granted",
      grants: [grant(["*"])],
    });
    expect(h.state).toBe("full");
    expect(h.danger).toEqual({ full: true, approves: true, deletes: true });
    expect(h.sentence).toBe(`${GRANT_FULL_ACCESS_SENTENCE}.`);
  });

  it("a granted set with no grant may touch nothing yet", () => {
    const h = key({ source: "grants", access: "granted", grants: [] });
    expect(h.state).toBe("nothing");
    expect(h.sentence).toBe(`${HOLDER_NO_ACCESS_SENTENCE}.`);
  });

  it("patterns outside the catalog surface as other", () => {
    const h = key({
      source: "grants",
      access: "granted",
      grants: [grant(["vault.redeem", "document.read"])],
    });
    expect(h.other).toEqual(["vault.redeem"]);
    expect(h.state).toBe("limited");
  });
});

describe("resolveHolderAccess — agents", () => {
  // Rules out: [] (unrestricted) read as "can do nothing".
  it("empty capabilities are full access", () => {
    expect(agent([]).danger.full).toBe(true);
    expect(agent(null).state).toBe("full");
  });

  // Rules out: an agent read-only list reading "Nothing" — it reads what you read.
  it("read-only capabilities: reads everything, changes nothing, asks first", () => {
    const h = agent(["entity.read"], {
      posture: { mode: "ask", workspaceId: null },
    });
    expect(h.tiers).toEqual({
      read: HOLDER_EVERYTHING,
      change: null,
      approve: null,
    });
    expect(h.state).toBe("limited");
    expect(h.sentence).toBe("Reads everything. Asks you first.");
    expect(h.posture).toEqual({ mode: "ask", where: "Everywhere" });
    expect(h.draft).toEqual(agentCapabilitiesToDraft(["entity.read"]));
  });

  it("capabilities with a change, acting without asking in one space", () => {
    const h = agent(["entity.note.create"], {
      posture: { mode: "auto", workspaceId: "ws-sales" },
      workspaceNames: { "ws-sales": "Sales" },
    });
    expect(h.tiers.change).toBe(NOTES);
    expect(h.danger.deletes).toBe(false);
    expect(h.sentence).toBe(
      `Reads everything, changes ${NOTES}. Acts without asking in Sales.`
    );
  });

  // Rules out: a missing posture rendered as the calm default.
  it("an unread posture is 'unread', never a mode", () => {
    expect(agent(["entity.read"]).posture).toBe("unread");
    expect(agent(["entity.read"], { posture: null }).posture).toBe("unread");
  });

  // Rules out: the ceiling alone, ignoring a narrower live key.
  it("a live key narrows the ceiling (capability ∩ key grant)", () => {
    const keyBase = { expiresAt: null, lastUsedAt: null, revokedAt: null };
    const h = agent([], {
      keys: [
        {
          id: "k1",
          access: "granted",
          grants: [
            grant(["entity.note.read", "document"], { workspaceIds: ["ws-a"] }),
          ],
          ...keyBase,
        },
      ],
    });
    expect(h.danger.full).toBe(false);
    expect(h.tiers.read).toBe(
      `${NOTES}, ${resolveObjectNounPlural("document")}`
    );
    expect(h.tiers.change).toBe(resolveObjectNounPlural("document"));
    expect(h.where.anywhere).toBe(false);
    expect(h.where.spaces.map((s) => s.id)).toEqual(["ws-a"]);
    // A revoked key narrows nothing: the ceiling stands.
    const revoked = agent([], {
      keys: [
        {
          id: "k1",
          access: "granted",
          grants: [grant(["entity.note.read"])],
          ...keyBase,
          revokedAt: PAST,
        },
      ],
    });
    expect(revoked.danger.full).toBe(true);
  });
});

describe("resolveHolderAccess — apps", () => {
  // Rules out: per-space grants merged into one cross product.
  it("per-space grants: one line each, spaces named, no single draft", () => {
    const h = resolveHolderAccess({
      kind: "app",
      name: "synap.live",
      limits: {
        source: "grants",
        access: "granted",
        grants: [
          grant(["entity.person.create"], { workspaceIds: ["ws-sales"] }),
          grant(["entity.note.read"], { workspaceIds: ["ws-fin"] }),
        ],
      },
      workspaceNames: { "ws-sales": "Sales", "ws-fin": "Finance" },
      posture: { mode: "ask", workspaceId: null },
      now: NOW,
    });
    expect(h.lines).toHaveLength(2);
    expect(h.draft).toBeNull();
    expect(h.where.spaces).toEqual([
      { id: "ws-sales", name: "Sales" },
      { id: "ws-fin", name: "Finance" },
    ]);
    expect(h.tiers.read).toBe(NOTES);
    expect(h.tiers.change).toBe(resolveObjectNounPlural("person"));
    expect(h.sentence).toBe(
      `Reads ${NOTES}, changes ${resolveObjectNounPlural("person")} in Sales and Finance. Asks you first.`
    );
  });
});

describe("narrowRequestsToRead", () => {
  const r = (permission: string, workspaceId = "ws") => ({
    permission,
    workspaceId,
  });
  it("bare and kind-qualified subjects narrow to their read", () => {
    expect(
      narrowRequestsToRead([
        r("entity.note"),
        r("entity.note.*"),
        r("document"),
        r("entity"),
      ]).map((x) => x.permission)
    ).toEqual(["entity.note.read", "document.read", "entity.read"]);
  });
  // Rules out: narrowing ADDING a read that was never asked for.
  it("drops a request that never covered a read", () => {
    expect(
      narrowRequestsToRead([r("entity.note.create"), r("proposal.approve")])
    ).toEqual([]);
  });
  it("`*` becomes a read of every catalog subject, per space", () => {
    const out = narrowRequestsToRead([r("*", "a"), r("entity.read", "a")]);
    expect(out.map((x) => x.permission)).toContain("entity.read");
    expect(out.map((x) => x.permission)).toContain("proposal.read");
    expect(out.filter((x) => x.permission === "entity.read")).toHaveLength(1);
    expect(out.every((x) => x.workspaceId === "a")).toBe(true);
  });
});

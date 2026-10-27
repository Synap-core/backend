/**
 * F6 (founder, 2026-10-27) — an agent's held-writes pack is named through the
 * one title door: "Writes held for review: <agent>, <day>, <N> items", never
 * "Held writes Agent". Every door that titles a proposal from its
 * (proposalType, targetType, name) reaches this through the pod's
 * `extractProposalName` → `heldWritesPackName`.
 */
import { describe, it, expect } from "vitest";
import { heldWritesPackName } from "../deferred-writes.js";
import { buildObjectActionTitle } from "../../vocabulary/index.js";

const AGENT = "0cf10d69-c16c-499a-8a1b-1f2e3d4c5b6a";
const write = (ref: string) => ({
  ref,
  subjectType: "entity",
  action: "create",
  data: { profileSlug: "task", title: ref },
  sessionId: null,
  agentUserId: AGENT,
  userId: "person-1",
  at: "2026-10-27T09:00:00.000Z",
  fingerprint: `fp-${ref}`,
});
/** A pack as `fileHeldWrites` stores it: 2 readable writes + 1 broken entry. */
const pack = {
  day: "2026-10-27",
  agentUserId: AGENT,
  agentName: "Claude Code",
  deferredWrites: [write("w1"), write("w2"), { ref: "broken" }],
  source: "agent",
};
const title = (data: unknown, mood?: "imperative" | "past") =>
  buildObjectActionTitle({
    action: "held_writes",
    objectKind: "agent",
    objectName: heldWritesPackName(data) ?? null,
    mood,
  });

describe("the held-writes pack's title", () => {
  it("leads with 'Writes held for review:' then agent, day and the writes it holds now", () => {
    expect(title(pack)).toBe(
      "Writes held for review: Claude Code, 2026-10-27, 3 items"
    );
    expect(title(pack, "past")).toBe(
      "Writes held for review: Claude Code, 2026-10-27, 3 items"
    );
    expect(title({ ...pack, deferredWrites: [write("w1")] })).toBe(
      "Writes held for review: Claude Code, 2026-10-27, 1 item"
    );
  });

  it("never an id, never the kind's noun as a name, never 'Held writes Agent'", () => {
    for (const agentName of [AGENT, "Agent", "  ", undefined]) {
      const t = title({ ...pack, agentName });
      expect(t).toBe("Writes held for review: 2026-10-27, 3 items");
      expect(t).not.toMatch(/Held writes|held_writes|Agent/);
    }
    expect(
      buildObjectActionTitle({ action: "held_writes", objectKind: "agent" })
    ).toBe("Writes held for review");
  });

  it("names only a pack: a workspace join (no day) or a plain payload is not one", () => {
    expect(
      heldWritesPackName({ agentUserId: AGENT, deferredWrites: [] })
    ).toBeUndefined();
    expect(heldWritesPackName({ title: "Plan" })).toBeUndefined();
    expect(heldWritesPackName(null)).toBeUndefined();
  });

  it("other actions keep their verb + noun + name shape", () => {
    expect(
      buildObjectActionTitle({
        action: "create",
        objectKind: "task",
        objectName: "Ship v2",
      })
    ).toBe('Create Task "Ship v2"');
  });
});

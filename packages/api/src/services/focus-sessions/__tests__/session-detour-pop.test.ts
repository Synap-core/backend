/**
 * POP does not close the PARENT.
 *
 * `session --spawned_from--> session` (the detour stack) gives a session a
 * parent for the first time. The failure mode a stack invites is a cascade:
 * closing the detour also closing the thing you were pushed away from, which
 * would silently end work the operator never finished.
 *
 * The invariant: NO close door reads the `spawned_from` edge, and every
 * `focus_sessions` status write in a close path is keyed on the session id the
 * caller named. A parent is closed only by closing the parent.
 *
 * Source-parsed on purpose — it must fail in CI without a database, and at the
 * point of EDIT rather than when someone loses an afternoon of work. It proves
 * the ABSENCE of a cascade; it does not exercise the runtime close.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVICES = join(__dirname, "..");
const API_SRC = join(SERVICES, "../..");

/** Every door that flips a focus session to a terminal status. */
const CLOSE_DOORS = [
  join(SERVICES, "complete-session.ts"),
  join(API_SRC, "routers/focus-sessions.ts"),
  join(API_SRC, "routers/hub-protocol/rest/focus-sessions.ts"),
];

describe("detour pop", () => {
  it.each(CLOSE_DOORS)(
    "%s never RESOLVES a parent — the pop cannot cascade",
    (path) => {
      const src = readFileSync(path, "utf8");
      // Reading the edge is the only way a close door could reach a parent row.
      // (The Hub REST file legitimately ACCEPTS a parentSessionId on its CREATE
      // body — accepting one is not resolving one.)
      expect(src).not.toMatch(/getParentSessionIds?\s*\(/);
      expect(src).not.toMatch(/linkType[^\n]*spawned_from/);
    }
  );

  it("neither close service mentions the detour edge at all", () => {
    for (const path of [
      join(SERVICES, "complete-session.ts"),
      join(API_SRC, "routers/focus-sessions.ts"),
    ]) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(/spawned_from/);
    }
  });

  it("complete-session updates exactly the session it was given", () => {
    const src = readFileSync(join(SERVICES, "complete-session.ts"), "utf8");
    const updates = [
      ...src.matchAll(/\.update\(focusSessions\)[\s\S]*?\.where\(([^)]*\))/g),
    ];
    expect(updates.length, "no focusSessions update found").toBeGreaterThan(0);
    for (const m of updates) {
      // The only accepted predicate is the caller-named id. Anything joining to
      // another session row (a parent lookup) fails here.
      expect(m[1].replace(/\s+/g, "")).toBe("eq(focusSessions.id,sessionId)");
    }
  });

  it("the spawn producer never writes a status onto either session", () => {
    const src = readFileSync(
      join(API_SRC, "../../database/src/utils/session-spawn.ts"),
      "utf8"
    );
    expect(src).not.toMatch(/status/);
    expect(src).not.toMatch(/closedAt/);
  });
});

/**
 * POP does not close the PARENT.
 *
 * `session --spawned_from--> session` (the detour stack) gives a session a
 * parent for the first time. The failure mode a stack invites is a cascade:
 * closing the detour also closing the thing you were pushed away from, which
 * would silently end work the operator never finished.
 *
 * The invariant: NO CLOSE PATH reads the `spawned_from` edge, and every
 * `focus_sessions` status write in a close path is keyed on the session id the
 * caller named. A parent is closed only by closing the parent.
 *
 * Scoped to close PATHS, not to whole FILES, on purpose. The file-level form of
 * this test matched one symbol name (`getParentSessionId(`) and went green the
 * moment the same lookup arrived in `routers/focus-sessions.ts` under a wrapper
 * with a different name — `list`/`get` legitimately project a parent id from
 * that very file. A rule a rename satisfies is not a rule, so the assertion now
 * names the property (close paths reach no parent) rather than a spelling, and
 * matches EVERY door into the lineage module.
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

const ROUTER = join(API_SRC, "routers/focus-sessions.ts");
const HUB_REST = join(API_SRC, "routers/hub-protocol/rest/focus-sessions.ts");
const COMPLETE = join(SERVICES, "complete-session.ts");

/**
 * EVERY door into the lineage projection, not one spelling of it. The read
 * lives in `@synap/database` (`getParentSessionId`/`getParentSessionIds`) and
 * is wrapped by `services/focus-sessions/parent-lineage.ts`
 * (`withParentSessionId`/`attachParentSessionIds`); reaching a parent row
 * requires naming one of them, or the edge itself.
 */
const LINEAGE =
  /getParentSessionIds?\s*\(|withParentSessionId\s*\(|attachParentSessionIds\s*\(|parent-lineage|spawned_from/;

/**
 * Slice one tRPC procedure's body out of a router. Procedures are top-level
 * entries of the `router({ … })` object literal, so a body runs from its own
 * `  name: <x>Procedure` header to the next one (or to end of file).
 */
function procedureBody(src: string, name: string): string {
  const header = new RegExp(
    `^  ${name}: (?:protected|workspace|public|admin)Procedure$`,
    "m"
  );
  const start = src.search(header);
  expect(
    start,
    `procedure '${name}' not found — the extractor is stale`
  ).toBeGreaterThanOrEqual(0);
  const rest = src.slice(start + 1);
  const next = rest.search(
    /^ {2}\w+: (?:protected|workspace|public|admin)Procedure$/m
  );
  return next === -1 ? rest : rest.slice(0, next);
}

describe("detour pop", () => {
  it("the close PROCEDURES of the tRPC router reach no parent", () => {
    const src = readFileSync(ROUTER, "utf8");
    // Both doors that flip a session to a terminal status: the status-closed
    // funnel inside `update`, and the canonical `close`.
    for (const name of ["update", "close"]) {
      expect(procedureBody(src, name), name).not.toMatch(LINEAGE);
    }
  });

  it("the extractor actually sees lineage where lineage exists", () => {
    // Self-check. Without it, a renamed/moved procedure would make the slices
    // above empty and the tripwire would pass by finding nothing at all —
    // exactly the failure this rewrite exists to close. `list`/`get` are
    // read-only projections and are SUPPOSED to match.
    const src = readFileSync(ROUTER, "utf8");
    for (const name of ["list", "get"]) {
      expect(procedureBody(src, name), name).toMatch(LINEAGE);
    }
  });

  it("every focus_sessions status write in the router is keyed on the caller's id", () => {
    const src = readFileSync(ROUTER, "utf8");
    const updates = [
      ...src.matchAll(/\.update\(focusSessions\)[\s\S]*?\.where\(([^)]*\))/g),
    ];
    expect(updates.length, "no focusSessions update found").toBeGreaterThan(0);
    for (const m of updates) {
      // A parent lookup could only cause a cascade by reaching an update. The
      // only accepted predicate is the id the caller named.
      expect(m[1].replace(/\s+/g, "")).toBe("eq(focusSessions.id,input.id)");
    }
  });

  it("the close service mentions the detour edge nowhere at all", () => {
    // `complete-session.ts` is a close door end to end — no read-only half to
    // carve out, so the whole file is the unit.
    expect(readFileSync(COMPLETE, "utf8")).not.toMatch(LINEAGE);
  });

  it("the Hub REST door ACCEPTS a parent on create but never RESOLVES one", () => {
    // Accepting a `parentSessionId` on the CREATE body is not resolving one —
    // it is handed to the producer, which owns the owner floor. What must not
    // appear is a lookup.
    const src = readFileSync(HUB_REST, "utf8");
    expect(src).not.toMatch(
      /getParentSessionIds?\s*\(|withParentSessionId\s*\(|attachParentSessionIds\s*\(|parent-lineage/
    );
    expect(src).not.toMatch(/linkType[^\n]*spawned_from/);
  });

  it("complete-session updates exactly the session it was given", () => {
    const src = readFileSync(COMPLETE, "utf8");
    const updates = [
      ...src.matchAll(/\.update\(focusSessions\)[\s\S]*?\.where\(([^)]*\))/g),
    ];
    expect(updates.length, "no focusSessions update found").toBeGreaterThan(0);
    for (const m of updates) {
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

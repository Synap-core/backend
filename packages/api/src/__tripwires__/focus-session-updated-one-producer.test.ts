import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE — `focus_session:updated` has ONE producer: the listener on
 * migration 0277's row trigger (`utils/session-changed-listener.ts`).
 *
 * History: the push used to be emitted by hand from 4 of ~41 session writers,
 * so most writes left open session pages stale. A trigger catches every writer
 * by construction; a hand emit next to it would be a SECOND producer — a
 * double push, and the first step back to a hand-maintained list (the
 * pre-0277 emits also leaked `goal` to the workspace room).
 *
 * Fails when, in non-test source under any backend `packages/<pkg>/src` or
 * `apps/<app>/src` (derived by globbing, not listed):
 *  1. a string literal `"focus_session:updated"` appears outside the listener;
 *  2. a string literal `"focus_session.{create,update,delete}.completed"`
 *     appears anywhere (the domain bridge no longer maps it — such an emit is
 *     dead code that reads like a push);
 *  3. `FOCUS_SESSION_UPDATED` or `emitSessionUpdated` is referenced outside
 *     the listener (re-exporting the name to emit elsewhere).
 *
 * Comments are skipped (a line starting with `//`, `*` or `/*`, and any
 * trailing `// …`), so prose may name the event. Does NOT see: the wire name
 * assembled from pieces (`"focus_session" + ":…"`), code inside a block
 * comment's continuation that does not start with `*`, or a producer in
 * another repo (IS / CP post to the bridge over HTTP).
 */

const BACKEND = join(__dirname, "..", "..", "..", "..");
const LISTENER = "packages/api/src/utils/session-changed-listener.ts";

const WIRE_LITERAL = /["'`]focus_session:updated["'`]/;
const BRIDGE_EVENT_LITERAL =
  /["'`]focus_session\.(?:create|update|delete)\.completed["'`]/;
const PRODUCER_IDENT = /\b(?:FOCUS_SESSION_UPDATED|emitSessionUpdated)\b/;

function srcRoots(): string[] {
  const roots: string[] = [];
  for (const group of ["packages", "apps"]) {
    const base = join(BACKEND, group);
    for (const name of readdirSync(base)) {
      const src = join(base, name, "src");
      try {
        if (statSync(src).isDirectory()) roots.push(src);
      } catch {
        // no src/ in this package — nothing to scan
      }
    }
  }
  return roots;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (
      /\.(ts|tsx|js|mjs)$/.test(name) &&
      !/\.test\.(ts|tsx)$/.test(name) &&
      !name.endsWith(".d.ts")
    )
      out.push(p);
  }
}

function scan() {
  const files: string[] = [];
  for (const root of srcRoots()) walk(root, files);
  const hits: string[] = [];
  let listenerHasWire = false;
  for (const file of files) {
    const rel = relative(BACKEND, file);
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((raw, i) => {
      const at = `${rel}:${i + 1}: ${raw.trim()}`;
      const trimmed = raw.trim();
      if (/^(\/\/|\*|\/\*)/.test(trimmed)) return;
      const line = raw.replace(/\s\/\/.*$/, "");
      if (rel === LISTENER) {
        if (WIRE_LITERAL.test(line)) listenerHasWire = true;
        if (BRIDGE_EVENT_LITERAL.test(line)) hits.push(at);
        return;
      }
      if (
        WIRE_LITERAL.test(line) ||
        BRIDGE_EVENT_LITERAL.test(line) ||
        PRODUCER_IDENT.test(line)
      )
        hits.push(at);
    });
  }
  return { files, hits, listenerHasWire };
}

describe("focus_session:updated — one producer (the 0277 trigger listener)", () => {
  it("the scan is not vacuous", () => {
    const { files, listenerHasWire } = scan();
    // Derived set: every backend package + app src/. Hundreds of files.
    expect(files.length).toBeGreaterThan(1000);
    expect(files.some((f) => f.endsWith("apps/api/src/index.ts"))).toBe(true);
    expect(files.some((f) => f.includes("packages/jobs/src/"))).toBe(true);
    // The ONE producer still carries the wire name the clients map.
    expect(listenerHasWire).toBe(true);
    // The patterns can still see a literal sample of what they hunt.
    expect(WIRE_LITERAL.test(`event: "focus_session:updated",`)).toBe(true);
    expect(
      BRIDGE_EVENT_LITERAL.test(`eventType: "focus_session.update.completed",`)
    ).toBe(true);
    expect(PRODUCER_IDENT.test("emitSessionUpdated(id)")).toBe(true);
  });

  it("no other file emits or names the producer", () => {
    expect(scan().hits).toEqual([]);
  });
});

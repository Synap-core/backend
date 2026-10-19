import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";

/**
 * ROW-ACTING-CONTEXT-ONE-DOOR TRIPWIRE
 *
 * `resolveActingContext` is a CREATE door: with no `workspaceId` it answers
 * "pod-personal write, you are the owner" and compares NO identity. Fed a
 * LOADED row's nullable `workspaceId` (`row.workspaceId ?? undefined`), it let
 * any authenticated hub caller who knew a pod-personal row's id read or write
 * another user's row — PATCH /focus-sessions/:id, /used, /channel, /outputs,
 * /complete-run, PATCH /artifacts/:id, /runs/:id/capture all shipped that way.
 * A load-then-authorize door goes through `resolveRowActingContext` (the owner
 * floor for a pod-personal row, membership for a workspace row).
 *
 * The scanned set is DERIVED: every non-test `.ts` under
 * `routers/hub-protocol/`, so a new route file joins by existing.
 *
 * What it catches: a `resolveActingContext(` call whose argument text carries
 * `<x>.workspaceId ?? undefined` or `<x>.workspaceId || undefined`. The
 * `?? undefined` is the tell of a nullable DB column; request input is already
 * `string | undefined` and never needs it.
 * What it does NOT catch, measured by reading the scan: a row's workspace
 * hoisted into a local first (`const ws = row.workspaceId ?? undefined;
 * resolveActingContext(c, { workspaceId: ws })`), or a non-null assertion
 * (`row.workspaceId!`). The behavioural floor is pinned per door by
 * `routers/hub-protocol/rest/row-acting-context.floor.test.ts`.
 */

const SRC = join(process.cwd(), "src");
const HUB = join(SRC, "routers", "hub-protocol");

function listTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return listTs(p);
    return e.name.endsWith(".ts") && !/\.test\.ts$/.test(e.name) ? [p] : [];
  });
}

/** The argument text of every `resolveActingContext(` call (balanced parens). */
function actingCallArgs(src: string): string[] {
  const out: string[] = [];
  const open = "resolveActingContext(";
  let i = src.indexOf(open);
  while (i !== -1) {
    let j = i + open.length;
    let depth = 1;
    while (depth > 0 && j < src.length) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")") depth--;
      j++;
    }
    out.push(src.slice(i + open.length, j - 1));
    i = src.indexOf(open, j);
  }
  return out;
}

const LOADED_ROW_WORKSPACE =
  /\b[A-Za-z_$][\w$]*\.workspaceId\s*(?:\?\?|\|\|)\s*undefined\b/;

describe("load-then-authorize hub doors go through resolveRowActingContext", () => {
  const files = listTs(HUB);
  const calls = files.flatMap((f) =>
    actingCallArgs(readFileSync(f, "utf8")).map((args) => ({
      file: relative(SRC, f),
      args,
    }))
  );

  it("the scan sees the hub routes (non-vacuity)", () => {
    expect(files.length).toBeGreaterThan(50);
    // ~130 call sites today; a scan that stops parsing calls reads ~0.
    expect(calls.length).toBeGreaterThan(80);
  });

  it("the detector still sees a literal sample of the defect", () => {
    const sample = `const acting = await resolveActingContext(c, {
        workspaceId: session.workspaceId ?? undefined,
      });`;
    const args = actingCallArgs(sample);
    expect(args).toHaveLength(1);
    expect(LOADED_ROW_WORKSPACE.test(args[0])).toBe(true);
    // ...and does not flag request input or the create shape.
    for (const ok of [
      "c, { workspaceId: body.workspaceId }",
      "c, { workspaceId: workspaceId ?? undefined }",
      "c, {}",
    ]) {
      expect(LOADED_ROW_WORKSPACE.test(ok)).toBe(false);
    }
  });

  it("no resolveActingContext call is fed a loaded row's nullable workspaceId", () => {
    const offenders = calls
      .filter((c) => LOADED_ROW_WORKSPACE.test(c.args))
      .map((c) => `${c.file}: resolveActingContext(${c.args.trim()})`);
    expect(
      offenders,
      "A loaded row's NULL workspace makes resolveActingContext answer 'owner' " +
        "without comparing identities. Use resolveRowActingContext(c, row, { notFound })."
    ).toEqual([]);
  });

  it("the door keeps its owner floor for a pod-personal row", () => {
    const shared = readFileSync(join(HUB, "rest", "_shared.ts"), "utf8");
    const start = shared.indexOf(
      "export async function resolveRowActingContext("
    );
    expect(start).toBeGreaterThan(-1);
    const body = shared.slice(start, shared.indexOf("\n}\n", start));
    expect(body).toMatch(/mayActAsUser\(c, row\.userId\)/);
  });
});

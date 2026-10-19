import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../../../scripts/strip-comments.mjs";

/**
 * An object body (`app/_lib/object/views/*`) is drawn in two frames: the
 * console (pod-admin only) and `/open` — which any signed-in MEMBER reaches
 * from a link. So a body must never ask a pod-admin-only door
 * (`*.admin*` procedures, `podAdminProcedure`) for every reader: a member's
 * page then fires a request the pod refuses, and whatever it fed silently
 * reads empty. The template page did exactly that with
 * `workspaces.adminListAll` when it was extracted for `/open/playbook`.
 *
 * Rule: every `trpc.<router>.admin<Name>.use…Query(` in a view carries an
 * `enabled:` that names `viewerIsPodAdmin`.
 */

const VIEWS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "app/_lib/object/views"
);

const ADMIN_READ = /trpc\.\w+\.(admin\w*)\.use(?:Infinite)?Query\(/g;

/** The argument list of the call opened at `start` (just past its `(`). */
function callArgs(src: string, start: number): string {
  let depth = 1;
  let i = start;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") depth--;
  }
  return src.slice(start, i - 1);
}

export function ungatedAdminReads(src: string): string[] {
  const code = stripComments(src, "ts");
  const out: string[] = [];
  for (const m of code.matchAll(ADMIN_READ)) {
    const args = callArgs(code, m.index! + m[0].length);
    if (!/enabled:[^,}]*\bviewerIsPodAdmin\b/.test(args)) out.push(m[1]!);
  }
  return out;
}

describe("object views never ask an admin-only door for a member", () => {
  it("the scan sees a gated read and an ungated one (fixture)", () => {
    const fixture = [
      "const a = trpc.workspaces.adminListAll.useQuery(undefined, {",
      "  enabled: viewerIsPodAdmin && Boolean(id),",
      "});",
      "const b = trpc.apiKeys.adminListAll.useQuery(undefined, { staleTime: 1 });",
      "// trpc.x.adminGet.useQuery(undefined)",
    ].join("\n");
    expect(ungatedAdminReads(fixture)).toEqual(["adminListAll"]);
  });

  it("every view gates its admin-only reads on the viewer being a pod admin", () => {
    const files = readdirSync(VIEWS_DIR).filter((f) => f.endsWith(".tsx"));
    expect(files.length).toBeGreaterThan(3);
    const offenders = files.flatMap((f) =>
      ungatedAdminReads(readFileSync(join(VIEWS_DIR, f), "utf8")).map(
        (door) => `${f}: ${door}`
      )
    );
    expect(offenders).toEqual([]);
  });
});

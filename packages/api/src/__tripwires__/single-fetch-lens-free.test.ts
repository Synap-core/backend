import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE — a single-object read is NEVER gated by the workspace lens.
 *
 * The principle: fetching ONE identified object (get / getById / getBy<X>)
 * resolves VISIBILITY from the user floor alone. The workspace/project lens may
 * only affect projection (which overlay/facet to foreground) and must never be
 * able to 404/403/empty the fetch. Lists, by contrast, legitimately take the
 * lens as a filter.
 *
 * `workspaceProcedure` throws BAD_REQUEST when no workspace lens is active and
 * FORBIDDEN if the caller isn't a member of that exact one — BEFORE the handler
 * runs. That is a hard precondition on the lens, correct for workspace-scoped
 * CREATES/MUTATIONS but never for a get-by-id: it turns "no active workspace"
 * (pod-wide lens) into a failed read of an object the user can plainly see.
 * This was the root cause of the pod-wide-lens document spinner and a class of
 * cross-workspace false-404s.
 *
 * So: a single-object getter must be mounted on protectedProcedure or
 * podProcedure (which tolerate a null lens) plus an explicit user-floor
 * predicate — the shape entities.get, documents.get, views.get, proposals.get,
 * projects.get, tools.get, playbooks.get, artifacts.get, roles.get, and
 * profiles.get all use.
 *
 * If this fails: a `get` / `getById` / `getBy<X>` procedure was mounted on
 * `workspaceProcedure`. Move it to podProcedure (or protectedProcedure) and
 * resolve visibility with a user-floor predicate; if it genuinely needs a
 * workspace for projection, take it as an explicit optional input or fall back
 * to a global/own-workspace default — never gate the read on the ambient lens.
 * Do NOT add an allowlist entry.
 */

// A single-object read mounted on workspaceProcedure — the forbidden pattern.
// Matches ONLY the unambiguous single-fetch names `get` / `getById`. Notably it
// does NOT match `getBy<X>`: that name is ambiguous — getByDocumentId is single,
// but getByMessage / getByTarget / getByProfile are workspace-scoped LISTS that
// legitimately keep the lens. list/search/aggregate reads (list, search,
// getCounts*, getEffective*) likewise do not match. Mirrors the frontend
// isSingleObjectRead rule in synap-client/src/links/workspaceLink.ts.
const SINGLE_GET_ON_WORKSPACE_PROC =
  /^\s+(get|getById)\s*:\s*workspaceProcedure\b/gm;

// The genuine single-object getBy<uniqueKey> reads — guarded explicitly since
// the regex above can't tell them apart from the list getBy* forms. Keep in
// sync with SINGLE_OBJECT_READ_PROCEDURES in the frontend workspaceLink.ts.
const SINGLE_GETBY_ON_WORKSPACE_PROC =
  /^\s+(getByDocumentId|getBySemanticSlug)\s*:\s*workspaceProcedure\b/gm;

function tsFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      tsFiles(p, acc);
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      acc.push(p);
    }
  }
  return acc;
}

const ROUTERS_ROOT = join(process.cwd(), "src", "routers");

describe("tripwire: single-object reads are lens-free (never workspaceProcedure)", () => {
  it("the detector regex is alive (matches a known-bad fixture)", () => {
    // Guards against a dead regex silently passing forever.
    const bad = "  getById: workspaceProcedure\n    .input(z.object({}))";
    expect(new RegExp(SINGLE_GET_ON_WORKSPACE_PROC).test(bad)).toBe(true);
    // ...and does NOT flag a list/aggregate read, a getBy* list, or a mutation.
    const ok =
      "  getEffectiveService: workspaceProcedure\n" +
      "  getByProfile: workspaceProcedure\n" +
      "  list: workspaceProcedure";
    expect(new RegExp(SINGLE_GET_ON_WORKSPACE_PROC).test(ok)).toBe(false);
  });

  it("no get / getById / single-object getBy* is mounted on workspaceProcedure", () => {
    const scan = (re: RegExp) =>
      tsFiles(ROUTERS_ROOT).flatMap((f) => {
        const hits = readFileSync(f, "utf8").match(re) ?? [];
        return hits.map((h) => `${relative(process.cwd(), f)} → ${h.trim()}`);
      });
    const offenders = [
      ...scan(SINGLE_GET_ON_WORKSPACE_PROC),
      ...scan(SINGLE_GETBY_ON_WORKSPACE_PROC),
    ];
    expect(offenders).toEqual([]);
  });
});

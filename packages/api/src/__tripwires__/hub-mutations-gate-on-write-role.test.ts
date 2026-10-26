import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

/**
 * TRIPWIRE — a mutating Hub route never gates on `verifyWorkspaceAccess`.
 *
 * MEASURED DEFECT (2d828af5, 2026-10-23): `POST /files` and
 * `POST /files/uploads` let a VIEWER write into a space, because their only
 * check was `verifyWorkspaceAccess` (`rest/_shared.ts`): any membership row,
 * role ignored. The same helper gated `/cells/install`, `/cells/define`,
 * `DELETE /cells/:typeKey`, both whiteboard placements and the attachments
 * route. A write gates on `verifyWorkspaceWriteAccess` (the editor+ floor of
 * `assertWorkspaceWrite`); `verifyWorkspaceAccess` is a READ check.
 *
 * HOW IT SCANS: every non-test `.ts` under `routers/hub-protocol/` is globbed
 * (a new route file joins by existing), comments are stripped, and each file
 * is cut into handler blocks at each `app.get|post|put|patch|delete|openapi(`.
 * A `verifyWorkspaceAccess(` call is allowed only in an `app.get(` block.
 * Everywhere else it is flagged: a post/put/patch/delete block, an `openapi`
 * block (its verb lives in a route definition this scan cannot read, so it
 * fails closed), and the code before a file's first handler (a helper a
 * mutation may call) unless EXEMPT names that helper with a reason.
 *
 * WHAT IT CANNOT SEE (measured by reading, not implied):
 *  - A route that reaches the membership check through a helper defined in
 *    ANOTHER module (only file-local preludes are scanned).
 *  - Other membership-only checks under other names (`getWorkspaceMembership`
 *    without a role test, `resolveActingContext`'s role-less floor).
 *  - Whether the write check guards the workspace the write really lands in.
 */

const HUB_DIR = join(__dirname, "..", "routers", "hub-protocol");

const MEMBERSHIP_CALL = /(?<!function\s+)\bverifyWorkspaceAccess\s*\(/;
const WRITE_CALL = /\bverifyWorkspaceWriteAccess\s*\(/;
const HANDLER_START = /\bapp\.(get|post|put|patch|delete|openapi)\(/g;
const HELPER_DECL =
  /(?:async\s+function|function)\s+([A-Za-z_$][\w$]*)\s*\(|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g;

/** `file::helper` → why this prelude helper may call the membership check. */
const EXEMPT: Record<string, string> = {};

interface Block {
  verb: string;
  head: string;
  code: string;
}

function blocksOf(src: string): { prelude: string; blocks: Block[] } {
  const code = stripComments(src, "ts");
  const starts = [...code.matchAll(HANDLER_START)];
  const prelude = code.slice(0, starts[0]?.index ?? code.length);
  const blocks = starts.map((m, i) => {
    const body = code.slice(m.index ?? 0, starts[i + 1]?.index ?? code.length);
    return { verb: m[1]!, head: body.split("\n")[0]!.trim(), code: body };
  });
  return { prelude, blocks };
}

/** Prelude helpers (by name) whose own body calls the membership check. */
function preludeCallers(prelude: string): string[] {
  const decls = [...prelude.matchAll(HELPER_DECL)];
  return decls
    .filter((m, i) =>
      MEMBERSHIP_CALL.test(
        prelude.slice(m.index ?? 0, decls[i + 1]?.index ?? prelude.length)
      )
    )
    .map((m) => m[1] ?? m[2] ?? "?");
}

export function offendersIn(file: string, src: string): string[] {
  const { prelude, blocks } = blocksOf(src);
  const offenders = preludeCallers(prelude)
    .map((name) => `${file}::${name}`)
    .filter((key) => !(key in EXEMPT));
  for (const b of blocks) {
    if (b.verb !== "get" && MEMBERSHIP_CALL.test(b.code)) {
      offenders.push(`${file}::${b.head}`);
    }
  }
  return offenders;
}

function hubFiles(): string[] {
  return (readdirSync(HUB_DIR, { recursive: true }) as string[]).filter(
    (f) =>
      f.endsWith(".ts") &&
      !f.endsWith(".test.ts") &&
      !f.endsWith(".d.ts") &&
      !f.includes("__tests__")
  );
}

describe("tripwire: mutating Hub routes gate on the write role", () => {
  it("no post/put/patch/delete/openapi handler calls verifyWorkspaceAccess", () => {
    const offenders: string[] = [];
    let mutating = 0;
    let writeGated = 0;
    for (const f of hubFiles()) {
      const src = readFileSync(join(HUB_DIR, f), "utf8");
      for (const b of blocksOf(src).blocks) {
        if (b.verb === "get") continue;
        mutating++;
        if (WRITE_CALL.test(b.code)) writeGated++;
      }
      offenders.push(...offendersIn(f.split("\\").join("/"), src));
    }
    // Non-vacuity: ~300 non-GET handlers exist, and nine of them gate on the
    // write check today (cells ×3, whiteboards ×2, entities ×4: attachments,
    // /files, /files/uploads, finalize). On origin/main before this guard the
    // scan flagged exactly those nine. A broken glob or splitter that sees no
    // handler would pass the assertion below trivially.
    expect(mutating).toBeGreaterThanOrEqual(200);
    expect(writeGated).toBeGreaterThanOrEqual(8);
    expect(offenders).toEqual([]);
  });

  it("self-check: the scan flags a membership-gated write and spares a read", () => {
    const synthetic = `
      async function helper(userId, ws) {
        return verifyWorkspaceAccess(userId, ws);
      }
      app.get("/r", async (c) => {
        if (!(await verifyWorkspaceAccess(userId, ws))) return c.json({}, 403);
      });
      app.post("/w", async (c) => {
        // verifyWorkspaceAccess( in a comment does not count
        if (!(await verifyWorkspaceAccess(userId, ws))) return c.json({}, 403);
      });
      app.openapi(route, async (c) => {
        await verifyWorkspaceAccess(userId, ws);
      });
      app.delete("/ok", async (c) => {
        if (!(await verifyWorkspaceWriteAccess(userId, ws))) return c.json({}, 403);
      });`;
    expect(offendersIn("synthetic.ts", synthetic)).toEqual([
      "synthetic.ts::helper",
      'synthetic.ts::app.post("/w", async (c) => {',
      "synthetic.ts::app.openapi(route, async (c) => {",
    ]);
  });
});

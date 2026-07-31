import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "capability-registry.ts"
);

/**
 * The action catalog and execute door must see the same workspace skill lens.
 * In particular, owning a workspace-A skill does not make it usable from
 * workspace B; the workspace scope remains a hard boundary.
 */
describe("capability registry skill visibility", () => {
  const src = readFileSync(FILE, "utf8");
  const skillRead = src.slice(
    src.indexOf("const skillRows = await db"),
    src.indexOf("// verb id", src.indexOf("const skillRows = await db"))
  );

  it("does not list an owner's workspace-A skill under workspace B", () => {
    // The lens must be the CALLER's identity + the CALLER's selected workspace,
    // threaded into the one shared predicate — never a hand-rolled owner check.
    // `ctx.workspaceId` is now `string | null` (pod altitude), so the argument
    // is normalized to `undefined`; `visibleSkillsWhere` then degrades to
    // `pod OR (user AND userId = caller)` — still owner-aware, still no
    // workspace-scoped rows.
    expect(skillRead).toMatch(
      /\.where\(\s*visibleSkillsWhere\(\s*ctx\.userId,\s*ctx\.workspaceId(\s*\?\?\s*undefined)?\s*\)\s*\)/
    );
    expect(skillRead).not.toContain("eq(skills.userId, ctx.userId)");
  });
});

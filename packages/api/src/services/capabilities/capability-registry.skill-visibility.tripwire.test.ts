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
    expect(skillRead).toContain(
      ".where(visibleSkillsWhere(ctx.userId, ctx.workspaceId))"
    );
    expect(skillRead).not.toContain("eq(skills.userId, ctx.userId)");
  });
});

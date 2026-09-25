/**
 * TRIPWIRE — the content-kind taxonomy has ONE source: `CONTENT_KINDS` in
 * `@synap-core/types/renderables` (the renderables catalog, which the browser's
 * `@synap-core/capabilities` re-exports).
 *
 * Two copies remain because their packages cannot import it yet, and each is
 * pinned here to the catalog, element for element and in order:
 *   - `@synap/database/schema` — the pod's column vocabulary (the database
 *     package does not depend on `@synap-core/types`);
 *   - the CLI (`synap-cli/src/commands/cell.ts`) — depends on neither types nor
 *     database; read from source text, SKIPPED when the sibling repo is absent
 *     (a missing checkout is not a drift).
 * The Control Plane's copies are guarded by `cp-pod-content-kind-parity`.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTENT_KINDS as DATABASE_CONTENT_KINDS } from "@synap/database/schema";
import { CONTENT_KINDS } from "@synap-core/types/renderables";

const REPO_ROOT = join(import.meta.dirname, "../../../../..");
const CLI_CELL = join(REPO_ROOT, "synap-cli/src/commands/cell.ts");

function literalConstKinds(src: string): string[] {
  const m = src.match(
    /export const CONTENT_KINDS\s*=\s*\[([\s\S]*?)\]\s*as const/
  );
  if (!m) throw new Error("CONTENT_KINDS not found — did it move?");
  const code = m[1]!.replace(/\/\/.*$/gm, "");
  return [...code.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

describe("tripwire: one content-kind taxonomy", () => {
  it("the catalog taxonomy is non-empty (non-vacuity)", () => {
    expect(CONTENT_KINDS.length).toBeGreaterThanOrEqual(5);
    expect([...CONTENT_KINDS]).toContain("widget");
  });

  it("the database copy equals the catalog", () => {
    expect([...DATABASE_CONTENT_KINDS]).toEqual([...CONTENT_KINDS]);
  });

  it.skipIf(!existsSync(CLI_CELL))("the CLI copy equals the catalog", () => {
    const cli = literalConstKinds(readFileSync(CLI_CELL, "utf8"));
    expect(cli.length, "extractor found nothing").toBeGreaterThan(0);
    expect(cli).toEqual([...CONTENT_KINDS]);
  });
});

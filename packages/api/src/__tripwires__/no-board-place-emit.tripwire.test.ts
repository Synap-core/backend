/**
 * TRIPWIRE — nothing on the server emits `board:place` any more.
 *
 * `board:place` was a socket event every open browser applied on its own:
 * with two viewers an agent's shapes landed twice (random ids), with none they
 * were lost while the API answered "placed", and nothing governed it. The ONE
 * way to put shapes on a board is the place door (`placeOnBoard`,
 * services/whiteboards/place-on-board.ts), which writes the board's records
 * through the realtime bridge (`POST /yjs/:roomId/apply`).
 *
 * Scanned: every non-test TypeScript source under `packages/<pkg>/src` (the
 * set is DERIVED from the tree), comments stripped (the shared scanner,
 * scripts/strip-comments.mjs). Any string literal
 * `board:place` (quoted or template) fails: that is how an emit names it.
 * Not seen: a name built at runtime (`"board:" + verb`), and other repos (the
 * browser's listener goes in its own lane).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const PACKAGES = join(REPO, "packages");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith("."))
      continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (
      /\.(ts|tsx|mts)$/.test(name) &&
      !/\.(test|spec)\.(ts|tsx|mts)$/.test(name) &&
      !name.endsWith(".d.ts")
    )
      out.push(path);
  }
  return out;
}

/** Does this source name the `board:place` event as a string? */
export function emitsBoardPlace(src: string): boolean {
  return /(["'`])board:place\1/.test(stripComments(src, "ts"));
}

describe("no code path emits board:place", () => {
  const files = readdirSync(PACKAGES)
    .map((pkg) => join(PACKAGES, pkg, "src"))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    })
    .flatMap((dir) => sources(dir));

  it("scans a real tree (non-vacuity)", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(
      files.some((f) => f.endsWith("services/whiteboards/place-on-board.ts"))
    ).toBe(true);
  });

  it("no source names the event", () => {
    const offenders = files
      .filter((f) => emitsBoardPlace(readFileSync(f, "utf8")))
      .map((f) => relative(REPO, f));
    expect(
      offenders,
      "Place shapes through placeOnBoard (services/whiteboards/place-on-board.ts), never a board:place event."
    ).toEqual([]);
  });

  it("the detector catches the retired emit and ignores a comment", () => {
    expect(
      emitsBoardPlace(`emitChatEvent({ event: "board:place", data, viewId });`)
    ).toBe(true);
    expect(emitsBoardPlace("socket.on('board:place', fn)")).toBe(true);
    expect(emitsBoardPlace("emit(`board:place`)")).toBe(true);
    expect(
      emitsBoardPlace(
        '/** its `board:place` stream */\n// emitted "board:place" once\nconst x = 1;'
      )
    ).toBe(false);
  });
});

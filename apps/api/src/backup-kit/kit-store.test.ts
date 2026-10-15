/**
 * The seam between deploy/pgdata-safety.sh (the writer) and kit-store.ts (the
 * backend's reader): the REAL shell functions write a kit and its marker into
 * a temp state dir, and the REAL readers parse them. Nothing is hand-built in
 * between, so a renamed file, a reworded password line or a new marker word
 * fails here instead of silently reading as "no kit".
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  kitPasswordTail,
  normalizeReadBack,
  readBackMatches,
  readKitMarker,
  readKitText,
  writeKitMarker,
} from "./kit-store.js";

const SAFETY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../deploy/pgdata-safety.sh"
);
const PASSWORD =
  "9a8b7c6d5e4f30211203f4e5d6c7b8a99a8b7c6d5e4f30211203f4e5d6c7b8a9";

/** Run `. pgdata-safety.sh; <script>` with the pod's state dir at `state`. */
function sh(state: string, script: string, ...args: string[]) {
  return execFileSync(
    "sh",
    ["-c", `. "$1"; shift; ${script}`, "_", SAFETY, ...args],
    {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        SYNAP_STATE_DIR: state,
        SYNAP_ENV_FILE: "/nonexistent",
      },
      encoding: "utf8",
    }
  );
}

describe("pgdata-safety.sh → kit-store (the real writer, the real reader)", () => {
  it("a kit printed by _bk_kit_print and marked by _bk_kit_mark reads back here", async () => {
    const state = mkdtempSync(join(tmpdir(), "kit-seam-"));
    const pw = join(state, "pw");
    writeFileSync(pw, PASSWORD);
    sh(
      state,
      '_bk_kit_layout && _bk_kit_print "b2:bucket:pods/x" "$1" > "$(_bk_kit_file)"',
      pw
    );
    expect(readKitMarker(state)).toBeNull(); // generated, not yet marked
    sh(state, "_bk_kit_mark pending");
    expect(readKitMarker(state)).toBe("pending");

    const text = await readKitText(state);
    expect(text).toContain("b2:bucket:pods/x");
    expect(kitPasswordTail(text!)).toBe(PASSWORD.slice(-6));

    // the backend's write is what the script's readers see
    await writeKitMarker(state, "saved");
    expect(sh(state, 'cat "$(_bk_kit_marker)"').trim()).toBe("saved");
    expect(readKitMarker(state)).toBe("saved");
  });

  it("the shell read-back and the route's read-back agree on every answer", () => {
    const state = mkdtempSync(join(tmpdir(), "kit-rb-"));
    const pw = join(state, "pw");
    writeFileSync(pw, PASSWORD);
    const tail = PASSWORD.slice(-6);
    for (const typed of [
      tail,
      tail.toUpperCase(),
      ` ${tail} `,
      "000000",
      PASSWORD.slice(0, 6),
      tail.slice(1),
      "",
    ]) {
      const shell = sh(
        state,
        '_bk_kit_readback_ok "$1" "$2" && echo yes || echo no',
        typed,
        pw
      ).trim();
      expect({ typed, ok: readBackMatches(typed, tail) }).toEqual({
        typed,
        ok: shell === "yes",
      });
    }
  });
});

describe("kit-store", () => {
  it("readKitText: null when no kit, the text when present", async () => {
    const state = mkdtempSync(join(tmpdir(), "kit-none-"));
    expect(await readKitText(state)).toBeNull();
  });

  it("kitPasswordTail: null for a kit with no password line", () => {
    expect(kitPasswordTail("Repository : x\n")).toBeNull();
  });

  it("readBackMatches needs exactly 6 characters after normalising", () => {
    expect(normalizeReadBack(" Ab Cd\tEF ")).toBe("abcdef");
    expect(readBackMatches("abcdef", "abcdef")).toBe(true);
    expect(readBackMatches("abcde", "abcdef")).toBe(false);
    expect(readBackMatches("abcdefa", "abcdef")).toBe(false);
  });
});

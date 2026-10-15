/**
 * The restic recovery kit as the backend sees it: `deploy/state/kit/`, written
 * by `deploy/pgdata-safety.sh` (`_bk_kit_*`) and mounted read-write into the
 * backend at `<stateDir>/kit` (compose nests it over the read-only deploy mount).
 *
 *   kit/recovery-kit.txt   the kit text (0600, owner = the backend's uid)
 *   kit/status             one word: `pending` | `saved`
 *
 * This module never logs and never returns the kit outside `readKitText`: the
 * only route that hands it out is the owner's download.
 */

import { timingSafeEqual } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type KitMarker = "pending" | "saved";

export const kitDir = (stateDir: string) => join(stateDir, "kit");
const kitFile = (stateDir: string) =>
  join(kitDir(stateDir), "recovery-kit.txt");
const markerFile = (stateDir: string) => join(kitDir(stateDir), "status");
/**
 * Where W7 pods wrote the marker. `_bk_kit_layout` moves it into `kit/` on the
 * backup loop's next pass; read as a fallback until then. Drop after every pod
 * ran one loop pass on the new script.
 */
const legacyMarkerFile = (stateDir: string) => join(stateDir, "recovery-kit");

function parseMarker(word: string): KitMarker | null {
  const w = word.trim();
  return w === "saved" || w === "pending" ? w : null;
}

/** The marker, or null when there is no kit to save (or the state is not visible here). */
export function readKitMarker(stateDir: string): KitMarker | null {
  for (const file of [markerFile(stateDir), legacyMarkerFile(stateDir)]) {
    try {
      return parseMarker(readFileSync(file, "utf8"));
    } catch {
      // absent or unreadable: try the next place
    }
  }
  return null;
}

/** The kit text; null when no kit was generated. Any other failure throws. */
export async function readKitText(stateDir: string): Promise<string | null> {
  try {
    return await readFile(kitFile(stateDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Atomic, like `_bk_kit_mark`: a reader never sees a half-written word. */
export async function writeKitMarker(
  stateDir: string,
  marker: KitMarker
): Promise<void> {
  const file = markerFile(stateDir);
  await writeFile(`${file}.new`, `${marker}\n`, { mode: 0o644 });
  await rename(`${file}.new`, file);
}

/** `_bk_kit_print`'s line `Password   : <hex>`. */
const PASSWORD_LINE = /^Password\s*:\s*(\S+)\s*$/m;

/** The password's last 6 characters, lower-cased; null when the kit has no password line. */
export function kitPasswordTail(kitText: string): string | null {
  const pw = PASSWORD_LINE.exec(kitText)?.[1];
  return pw && pw.length >= 6 ? pw.slice(-6).toLowerCase() : null;
}

/** What the owner typed, as compared: blanks dropped, lower-cased (the password is hex). */
export function normalizeReadBack(typed: string): string {
  return typed.replace(/\s+/g, "").toLowerCase();
}

/** Constant-time: the comparison never says how many characters were right. */
export function readBackMatches(typed: string, tail: string): boolean {
  const a = Buffer.from(normalizeReadBack(typed), "utf8");
  const b = Buffer.from(tail, "utf8");
  if (a.length !== 6 || b.length !== 6) return false;
  return timingSafeEqual(a, b);
}

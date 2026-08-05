/**
 * TRIPWIRE — no `emitChatEvent` under `src/notifications/` may pass a
 * `workspaceId` key.
 *
 * A notifications row is PRIVATE to `userId`. `workspace:${id}` is a room every
 * member of the workspace is in, and no client filters `notification:new` by
 * recipient — so passing `workspaceId` to the bridge discloses one member's
 * notification title/body to all the others. It also double-delivers when
 * `userId` is passed too (the bridge emits once per room key present).
 *
 * This greps the SOURCE rather than a fixed file list, so a NEW file added to
 * this directory is covered the day it lands (a fixed list would stay green
 * over a fresh hole).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const NOTIFICATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === "__tests__" ? [] : sourceFiles(full);
    }
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });
}

describe("notifications realtime emit tripwire", () => {
  const files = sourceFiles(NOTIFICATIONS_DIR);

  it("scans at least one source file (anti-vacuity for the grep itself)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s passes no workspaceId to emitChatEvent", (file) => {
    const src = readFileSync(file, "utf8");

    // Each `emitChatEvent({ ... })` call body, up to its closing `});`.
    const calls = [...src.matchAll(/emitChatEvent\(\{([\s\S]*?)\}\);/g)];

    for (const [, body] of calls) {
      expect(body).not.toMatch(/(^|[\s,{])workspaceId\s*[:,]/);
    }
  });
});

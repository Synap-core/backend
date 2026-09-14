/**
 * TRIPWIRE — the cleanup-pack cron stays UNSCHEDULED until a reviewer can see a
 * pack's items.
 *
 * One Approve on a `pod_hygiene/cleanup_pack` applies EVERY item in it: closes
 * sessions, retires kinds, pauses automations and EXPIRES proposals (terminal).
 * No surface renders those items with a per-item "Leave out" today — relay has
 * zero `proposals.rejectItem` callers, and desktop wires it only for composite
 * graphs. So a daily pack would be approved blind.
 *
 * RE-REGISTER CONDITION: relay's proposal screen renders a `cleanup_pack` with
 * one row per item and a "Leave out" that calls `proposals.rejectItem`. Then add
 * `scheduleSafe(boss, POD_HYGIENE_CLEANUP_PACK_QUEUE, POD_HYGIENE_CLEANUP_PACK_CRON, {})`
 * back to cron.ts, re-add the worker-registry entry, and delete this file.
 *
 * The worker itself stays `work()`ed (and created), so a deliberate manual
 * `boss.send("pod-hygiene.cleanup-pack", {})` still runs it.
 *
 * LIMIT: reads cron.ts source with comments stripped — it catches the schedule
 * call by name or by queue string; it cannot catch a schedule added from a
 * different file.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function code(file: string): string {
  return readFileSync(join(SRC, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("cleanup-pack cron is not scheduled (relay pack view first)", () => {
  const cron = code("cron.ts");
  const registry = code("worker-registry.ts");

  it("non-vacuity: the scan still sees cron.ts scheduling a sibling hygiene job", () => {
    expect(cron).toMatch(/scheduleSafe\(\s*boss,\s*LIBRARIAN_ARCHIVER_QUEUE/);
  });

  it("cron.ts does not schedule the cleanup pack", () => {
    expect(
      cron,
      "The cleanup-pack cron was re-scheduled. Only do that once relay renders a pack's items with a per-item 'Leave out' (proposals.rejectItem) — see this file's header."
    ).not.toMatch(/POD_HYGIENE_CLEANUP_PACK|pod-hygiene\.cleanup-pack/);
  });

  it("worker-registry does not advertise a cleanup-pack cron", () => {
    expect(registry).not.toMatch(/pod-hygiene-cleanup-pack/);
  });
});

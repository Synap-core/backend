/**
 * TRIPWIRE — the cleanup pack (the pod's janitor) is SCHEDULED, weekly, on
 * Monday before the 06:00 night shift (W-B4, founder Q-B4).
 *
 * It was built and left unscheduled until relay could review a pack item by
 * item; relay now does (`ItemPackReview`, `proposals.rejectItem`). An
 * unscheduled janitor is the failure this file exists for: 21 sessions idle
 * over 30 days sat in the founder's pod while the scanner that packs exactly
 * them never ran. Daily is noise; monthly lets 30-day debris pile up.
 *
 * What it pins:
 *   - the schedule constant is Monday 04:20 UTC, and that is before 06:00;
 *   - cron.ts schedules the cleanup-pack queue with that constant;
 *   - the worker registry advertises the same trigger (the admin UI's list).
 *
 * LIMIT: cron.ts is read as source with comments stripped, so it catches the
 * `scheduleSafe(boss, POD_HYGIENE_CLEANUP_PACK_QUEUE, POD_HYGIENE_CLEANUP_PACK_CRON`
 * call by name; it cannot see a schedule made from another file, nor prove
 * pg-boss accepted it (`queues-are-created.tripwire.test.ts` pins that the
 * queue is created, which is what makes `scheduleSafe` succeed).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "../../../../scripts/strip-comments.mjs";
import {
  POD_HYGIENE_CLEANUP_PACK_CRON,
  POD_HYGIENE_CLEANUP_PACK_QUEUE,
} from "../workers/pod-hygiene-cleanup-pack-cron.js";
import { workerRegistry } from "../worker-registry.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function code(file: string): string {
  return stripComments(readFileSync(join(SRC, file), "utf8"), "ts");
}

/** The night shift's local start, UTC hour (Q-B4: the pack lands before it). */
const NIGHT_SHIFT_HOUR_UTC = 6;

describe("cleanup-pack cron: weekly, Monday, before the night shift", () => {
  const cron = code("cron.ts");

  it("non-vacuity: the scan still sees cron.ts scheduling a sibling hygiene job", () => {
    expect(cron).toMatch(/scheduleSafe\(\s*boss,\s*LIBRARIAN_ARCHIVER_QUEUE/);
  });

  it("the schedule is Monday 04:20 UTC, before 06:00", () => {
    expect(POD_HYGIENE_CLEANUP_PACK_CRON).toBe("20 4 * * 1");
    const [minute, hour, dom, month, dow] =
      POD_HYGIENE_CLEANUP_PACK_CRON.split(" ");
    expect({ dom, month, dow }).toEqual({ dom: "*", month: "*", dow: "1" });
    expect(Number(hour) * 60 + Number(minute)).toBeLessThan(
      NIGHT_SHIFT_HOUR_UTC * 60
    );
  });

  it("cron.ts schedules the cleanup-pack queue with that constant", () => {
    expect(POD_HYGIENE_CLEANUP_PACK_QUEUE).toBe("pod-hygiene.cleanup-pack");
    expect(
      cron,
      "The cleanup pack is no longer scheduled: the pod's janitor never runs (W-B4)."
    ).toMatch(
      /scheduleSafe\(\s*boss,\s*POD_HYGIENE_CLEANUP_PACK_QUEUE,\s*POD_HYGIENE_CLEANUP_PACK_CRON\b/
    );
  });

  it("the worker registry advertises the same weekly trigger", () => {
    const entry = workerRegistry.find(
      (w) => w.id === "pod-hygiene-cleanup-pack"
    );
    expect(entry?.triggers).toEqual([`cron:${POD_HYGIENE_CLEANUP_PACK_CRON}`]);
  });
});

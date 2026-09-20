/**
 * TRIPWIRE — nothing writes the `notifications` table except the ONE write door.
 *
 * ── The defect this closes, and why it is worse than it sounds ──────────────
 * Three producers in `@synap/jobs` used to `db.insert(notifications)` directly,
 * because `NotificationService.create` lives in `@synap/api` and jobs cannot
 * import it (api depends on jobs, not the reverse). The obvious consequence was
 * "those notifications ignore preferences and never push".
 *
 * The REAL consequence was worse. `agent.task_failed` and `ai.proactive.insight`
 * each ALSO have a compliant producer in `packages/api`, so those two types were
 * PARTIALLY governed: muting `agent.task_failed` silenced failures reported
 * through the Hub REST door while headless A2AI turn failures kept arriving. A
 * switch that works sometimes does not read as a bug — it reads as a flaky
 * setting, or as user error. It is the hardest class of defect to diagnose from
 * the outside, and NEITHER producer looks wrong when read on its own. Only
 * asking "does this type have a SECOND producer?" surfaces it.
 *
 * `utils/notification-creator.ts` (the `registerNotificationCreator` IoC slot)
 * removed the reason to bypass. This tripwire removes the possibility.
 *
 * ── DERIVED, not a list ────────────────────────────────────────────────────
 * Every `.ts` under `packages/jobs/src` is scanned. A new worker joins this scan
 * BY EXISTING; there is no array to forget to update. A file that genuinely must
 * write the table names itself in `ALLOWED_DIRECT_WRITERS` below WITH a reason —
 * so the next one still goes red.
 *
 * ── What it does NOT cover, measured ───────────────────────────────────────
 * Granularity is the FILE, not the call site: a file already listed as an
 * allowed writer could add a second direct insert and stay green. It also only
 * sees the literal `insert(notifications`; an insert reached through an alias
 * (`const t = notifications; db.insert(t)`) would slip past. Both are accepted:
 * the realistic regression is someone copying the old pattern verbatim into a
 * new worker, which this catches. Verified by re-introducing a direct insert
 * into a scanned file and watching it go red.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { getNotificationDef } from "../notifications/registry.js";

/** `src/__tripwires__` → src → api → packages → synap-backend. */
const BACKEND_ROOT = join(import.meta.dirname, "../../../..");
const JOBS_SRC = join(BACKEND_ROOT, "packages/jobs/src");

/**
 * Files allowed to write `notifications` directly. Each MUST carry a reason.
 *
 * `workers/steps/output.ts` is the one genuine case: it is the automation
 * `notification` OUTPUT step, whose title, body, category and priority are all
 * authored by the USER in automation config. A registry type fixes exactly those
 * fields by design, so routing it through the door would either freeze the
 * user's choices or turn the registry into a pass-through. It is a different
 * shape, not an unfinished migration — see the lane report. Its `type` is
 * `automation.notification`, which is deliberately NOT in the registry and
 * therefore never appears in the settings catalogue, so it cannot produce a
 * lying switch.
 */
const ALLOWED_DIRECT_WRITERS: Record<string, string> = {
  "workers/steps/output.ts":
    "User-authored automation notification output: title/body/category/priority come from automation config, which a registry type fixes by design. Not in the registry, so it never renders a settings switch.",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "__tests__")
      continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.includes(".test.")) out.push(full);
  }
  return out;
}

/** Strip comments so prose describing the old pattern is never read as code. */
function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const DIRECT_INSERT = /\.insert\(\s*notifications\b/;

describe("TRIPWIRE: notifications have ONE write door", () => {
  const files = (() => {
    if (!existsSync(JOBS_SRC)) {
      throw new Error(
        `Tripwire cannot read its subject: ${JOBS_SRC}. A moved package must move this test, not silence it.`
      );
    }
    return walk(JOBS_SRC);
  })();

  it("the scan reached a plausible number of files (non-vacuity)", () => {
    // A walk that matched zero files would make every assertion below vacuously
    // true — the exact shape of a tripwire that passes forever guarding nothing.
    expect(files.length).toBeGreaterThan(20);
  });

  it("the pattern can still see a literal sample of what it hunts (self-check)", () => {
    expect(DIRECT_INSERT.test("await db.insert(notifications).values({")).toBe(
      true
    );
    expect(DIRECT_INSERT.test("await db.insert(chatTurns).values({")).toBe(
      false
    );
    // And the comment-stripper must not be what makes this pass.
    expect(strip("// db.insert(notifications)").trim()).toBe("");
  });

  it("no @synap/jobs file inserts into `notifications` directly", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(JOBS_SRC, file);
      if (ALLOWED_DIRECT_WRITERS[rel]) continue;
      if (DIRECT_INSERT.test(strip(readFileSync(file, "utf8")))) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      `These files write \`notifications\` directly, bypassing NotificationService — so routing preferences, quiet hours and push do NOT apply to them, and any settings switch for their type is a lie. Route them through \`createNotificationViaService\` (utils/notification-creator.ts), or add them to ALLOWED_DIRECT_WRITERS with a reason: ${offenders.join(", ")}`
    ).toEqual([]);
  });

  it("every allowed direct writer still exists and carries a reason", () => {
    // An exemption for a file that has been deleted or renamed is a stale
    // licence that silently widens the next time that path is recreated.
    for (const [rel, reason] of Object.entries(ALLOWED_DIRECT_WRITERS)) {
      expect(
        reason.length,
        `${rel} is exempt but carries no reason`
      ).toBeGreaterThan(20);
      expect(
        existsSync(join(JOBS_SRC, rel)),
        `${rel} is listed as an allowed direct writer but no longer exists — remove the exemption`
      ).toBe(true);
    }
  });
});

/**
 * A producer routed through the door can only emit a type the REGISTRY knows:
 * `NotificationService.create` logs "Unknown notification type — skipping" and
 * writes nothing otherwise. So a producer whose type vocabulary is WIDER than
 * the registry does not merely lose governance — it loses the notification.
 *
 * That was live. `ProactiveMessageType` has SEVEN members and the registry
 * declared FIVE (`suggestion` and `alert` were missing), which did not matter
 * while the producer inserted directly and would have silently dropped two of
 * seven proactive notifications the moment it was routed. This derives the
 * union from the producer's own source so the two can never drift again.
 */
describe("TRIPWIRE: every proactive type a routed producer can emit is in the registry", () => {
  const PROACTIVE_POST = join(JOBS_SRC, "utils/proactive-post.ts");

  const members = (() => {
    const src = readFileSync(PROACTIVE_POST, "utf8");
    const m = src.match(/export type ProactiveMessageType\s*=([\s\S]*?);/);
    if (!m) {
      throw new Error(
        "Could not parse ProactiveMessageType from proactive-post.ts — the tripwire's subject moved; move the tripwire, do not delete it."
      );
    }
    return [...m[1]!.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]!);
  })();

  it("parsed a plausible union (non-vacuity)", () => {
    // A regex that matched nothing would make the loop below iterate zero times
    // and pass forever.
    expect(members.length).toBeGreaterThanOrEqual(5);
    expect(members).toContain("morning_briefing");
    // The two that were missing, named so a silent removal is visible.
    expect(members).toContain("suggestion");
    expect(members).toContain("alert");
  });

  it.each(members.map((m) => [m]))(
    "ai.proactive.%s is declared in NOTIFICATION_REGISTRY",
    (member) => {
      expect(
        getNotificationDef(`ai.proactive.${member}`),
        `ProactiveMessageType "${member}" has no registry row, so routing it through NotificationService.create would write NOTHING — the notification is lost, not merely ungoverned. Add a row to registry.ts.`
      ).toBeTruthy();
    }
  );
});

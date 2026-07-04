import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE — every IS auto-respond goes through the ONE door.
 *
 * There is exactly one path that makes the Intelligence Service respond to a
 * message in a channel: `triggerAutoRespond()` (utils/trigger-auto-respond.ts),
 * which resolves the workspace's chat IS and enqueues the `A2AI_TRIGGER` pg-boss
 * job. Inlining that enqueue anywhere else (a bare `getBoss().send(A2AI_TRIGGER_
 * QUEUE, …)`) forks the pipeline — it bypasses the channel-type gate, the focus-
 * session resolution, and the service routing, and it is how doors drift out of
 * sync (the "triggerAI socket event that invokes nothing" class of bug).
 *
 * Spine 1 (Agent Turn) collapsed 4 inline enqueues + 2 broken socket-only doors
 * into this single helper. This test keeps it that way: the queue token — whether
 * the exported constant `A2AI_TRIGGER_QUEUE` OR the raw queue-name string
 * `"a2ai-response-trigger"` (which bypasses the constant) — may appear in api/src
 * ONLY inside the helper. If this fails: call
 * `triggerAutoRespond({ channelId, userMessageId, content, sourceUserId })`
 * instead of enqueuing the job yourself. Do NOT add your file to the allowlist.
 *
 * SCOPE NOTE: this scans only `api/src` (where the doors live). A door added in
 * another package (`@synap/jobs`, `@synap/database`) would be invisible here —
 * the worker itself legitimately names the queue, so this can't widen to the
 * whole repo without allowlisting it. New enqueue producers outside api MUST
 * still route through `triggerAutoRespond`.
 */

// The ONE door. This is the only file in api/src permitted to name the queue.
const ALLOWLIST = new Set<string>(["utils/trigger-auto-respond.ts"]);

// Both the exported constant AND the raw queue-name literal it expands to —
// naming either outside the helper forks the pipeline.
const BANNED = ["A2AI_TRIGGER_QUEUE", "a2ai-response-trigger"];

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      tsFiles(p, acc);
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      acc.push(p);
    }
  }
  return acc;
}

describe("tripwire: IS auto-respond has one door (triggerAutoRespond)", () => {
  it("no api/src file inlines the A2AI trigger-queue enqueue outside the helper", () => {
    const srcRoot = join(process.cwd(), "src");
    const offenders = tsFiles(srcRoot)
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return BANNED.some((token) => src.includes(token));
      })
      .map((f) => relative(srcRoot, f))
      .filter((rel) => !ALLOWLIST.has(rel));
    expect(offenders).toEqual([]);
  });
});

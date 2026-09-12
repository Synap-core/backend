/**
 * TRIPWIRE — every WRITER of a pod-wide proposal goes through the ONE ordered
 * door, `notifyProposalCreatedOrdered`.
 *
 * WHY: `notifyPodWideProposal` is reached by TWO arms — the writer, and the
 * `pod-wide-proposal-notify` reactor off the writer's `proposal.created` side
 * effect. Its idempotency guard is durable and order-independent, but not
 * simultaneity-proof: two arms started un-awaited both run the guard's SELECT
 * before either INSERT commits, and the human is told twice (observed live,
 * 2026-09-12: two bell rows 5 ms apart). The fix is sequencing, and sequencing
 * copied into five writers is a rule that will be half-true within a release.
 *
 * The caller set is DERIVED by globbing source — a new writer joins the scan by
 * existing, never by being added to a list here.
 *
 * WHAT THIS DOES NOT COVER, measured: it reads CALL SITES, not order of
 * execution. A file could call the door and then race it with something else.
 * The ordering itself is proven behaviourally, against a fake with real write
 * latency, in `notify-proposal-created-ordered.test.ts` and
 * `rest/__tests__/dev-approval-notification.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");

/** Every `.ts` under `src`, cwd-relative. Walked, never hand-listed. */
function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else if (entry.name.endsWith(".ts")) out.push(rel);
  }
  return out;
}

/** Blank out comments so a MENTION of a call never counts as the call. */
const strip = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (_m, p1) => p1);

const sources: { file: string; src: string }[] = walk(SRC)
  .filter(
    (f: string) => !f.includes("__tests__") && !f.includes("__tripwires__")
  )
  .filter((f: string) => !f.endsWith(".test.ts"))
  .map((f: string) => ({
    file: f,
    src: strip(readFileSync(resolve(SRC, f), "utf8")),
  }));

const calls = (needle: string): string[] =>
  sources.filter((s) => s.src.includes(needle)).map((s) => s.file);

/**
 * The three files that may name `notifyPodWideProposal` directly, each because
 * it CANNOT be a racing writer:
 *   - its own declaration;
 *   - the ordered door, which is the sequencing point itself;
 *   - the event-driven reactor, which emits nothing and so cannot race its own
 *     emit — it exists precisely for writers in `@synap/jobs` that cannot
 *     import this package at all.
 * Anything else is a writer, and a writer must go through the door.
 */
const ALLOWED_DIRECT = [
  "notifications/notify-pod-wide-proposal.ts",
  "notifications/notify-proposal-created-ordered.ts",
  "notifications/pod-wide-proposal-reactor.ts",
];

describe("tripwire: pod-wide proposal notification is ordered in ONE place", () => {
  it("scanned a plausible number of source files (non-vacuity)", () => {
    expect(sources.length).toBeGreaterThan(200);
  });

  it("can still SEE a direct call (self-check)", () => {
    // If this goes empty, the scan has been blinded and every assertion below
    // passes while looking at nothing.
    expect(calls("notifyPodWideProposal(")).toContain(
      "notifications/notify-pod-wide-proposal.ts"
    );
  });

  it("no WRITER calls notifyPodWideProposal directly", () => {
    const offenders = calls("notifyPodWideProposal(").filter(
      (f) => !ALLOWED_DIRECT.includes(f)
    );
    expect(
      offenders,
      `These files fan out a pod-wide proposal directly and will race the ` +
        `proposal.created reactor. Call notifyProposalCreatedOrdered instead ` +
        `(notifications/notify-proposal-created-ordered.ts).`
    ).toEqual([]);
  });

  it("the door has the writers it is supposed to have", () => {
    const writers = calls("notifyProposalCreatedOrdered(").filter(
      (f) => f !== "notifications/notify-proposal-created-ordered.ts"
    );
    // 5 today: permission-check + the four governance recommenders/wardens.
    // A floor, not an equality — a new writer joining is correct and must not
    // fail this; a writer VANISHING (inlined back to a direct call) is caught
    // by the assertion above.
    expect(writers.length).toBeGreaterThanOrEqual(5);
    expect(writers).toContain("utils/permission-check.ts");
  });
});

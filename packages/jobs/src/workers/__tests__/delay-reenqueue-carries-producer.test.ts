import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * CONFUSED-DEPUTY GUARD — the delay re-enqueue must carry `producerAgentUserId`.
 *
 * A `delay` node re-enqueues `automation-execute` with `startAfter` to resume the
 * rest of the DAG. The payload it builds is the ONLY channel by which the run's
 * causal-chain producer survives the suspension: `handleAutomationExecute`
 * re-reads `producerAgentUserId` off `job.data`. If the re-enqueue drops it, the
 * resumed invocation sees `undefined` → the confused-deputy guard finds no
 * producer → an agent-produced trigger's POST-DELAY THEN-actions (e.g.
 * `trigger → delay → entity_create`) auto-execute ungoverned under the human
 * owner — the exact leak the guard closes on the non-delay path.
 *
 * Driving the full executor through a real delay would need the entire DB surface
 * mocked; this freezes the one load-bearing line at source level instead (à la
 * `playbook-run-one-door.test.ts`). If it fails: add `producerAgentUserId` back to
 * the delay `boss.send("automation-execute", { … })` payload.
 */
describe("delay re-enqueue carries the causal-chain producer", () => {
  it("the automation-execute re-enqueue payload includes producerAgentUserId", () => {
    const src = readFileSync(
      join(__dirname, "..", "automation-executor.ts"),
      "utf8"
    );

    // Locate the delay re-enqueue: boss.send("automation-execute", { … }).
    const sendIdx = src.indexOf(
      'boss.send(\n                "automation-execute"'
    );
    expect(
      sendIdx,
      'could not find the delay boss.send("automation-execute", …) call'
    ).toBeGreaterThan(-1);

    // The payload object literal is the text between that call and its startAfter
    // option — assert the producer field is threaded into it.
    const window = src.slice(sendIdx, sendIdx + 1200);
    expect(
      /producerAgentUserId\b/.test(window),
      "the delay re-enqueue payload must carry producerAgentUserId so the guard survives the suspension"
    ).toBe(true);
    // And it must sit BEFORE the startAfter option (i.e. inside the payload).
    expect(window.indexOf("producerAgentUserId")).toBeLessThan(
      window.indexOf("startAfter")
    );
  });
});

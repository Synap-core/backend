/**
 * What the door tells an agent whose `supersedes` did not end the failed
 * proposal (wave-2 code review 1): two different facts, never one sentence.
 * "Filed nothing" was said to an agent whose call HAD filed a proposal (one of
 * another request, which the end then skipped): it believed nothing waited for
 * the person while a second request did. The insert door now refuses that
 * filing, so "filed, but it did not end" is left for a race the lock should
 * close; if it ever happens, the agent hears it as it is.
 */
import { describe, it, expect } from "vitest";
import { leftFailedNote } from "./supersedes-door.js";

const FAILED = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
const FILED = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";

describe("leftFailedNote", () => {
  it("a call that filed nothing says so, and that the failed one is still failed", () => {
    const note = leftFailedNote({
      proposalId: FAILED,
      replacedBy: null,
      filed: null,
      refused: null,
    });
    expect(note).toMatch(/filed nothing for review/);
    expect(note).toContain(`${FAILED} was left as it is (still failed)`);
  });

  it("a call that filed a proposal never says it filed nothing: it names both", () => {
    const note = leftFailedNote({
      proposalId: FAILED,
      replacedBy: null,
      filed: FILED,
      refused: null,
    });
    expect(note).not.toMatch(/filed nothing/);
    expect(note).toContain(`filed proposal ${FILED}`);
    expect(note).toContain(`${FAILED} did not end (still failed)`);
  });
});

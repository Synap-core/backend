/**
 * TRIPWIRE — a capture clarification part is written without ever starting an
 * agent turn.
 *
 * `postChannelMessage` triggers the IS for any USER message and
 * `triggerAutoRespond` IS the trigger, so neither may be reached from the units
 * that write a question or an answer:
 *   - `record-capture-part-message.ts` (the one writer),
 *   - `capture-clarification.ts` (persist / claim),
 *   - the `answerFollowUp` region of `routers/capture.ts`.
 *
 * Comments are stripped before scanning (the docblocks NAME the forbidden doors
 * to explain why). Granularity: the unit, one import level — a forbidden door
 * reached through a module these units import is NOT seen; the runtime guard in
 * `triggerAutoRespond` (`trigger-auto-respond.capture-part.pglite.test.ts`)
 * covers that.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "..", "..");
const BANNED = [
  /\btriggerAutoRespond\b/,
  /\bpostChannelMessage\b/,
  /trigger-auto-respond/,
  /messaging\/post-message/,
];

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function offenders(code: string): string[] {
  const stripped = stripComments(code);
  return BANNED.filter((re) => re.test(stripped)).map(String);
}

function units(): Array<{ name: string; code: string }> {
  const capture = readFileSync(join(SRC, "routers/capture.ts"), "utf8");
  const start = capture.indexOf("answerFollowUp: podProcedure");
  const end = capture.indexOf("// ── end answerFollowUp", start);
  return [
    {
      name: "services/intake/record-capture-part-message.ts",
      code: readFileSync(
        join(SRC, "services/intake/record-capture-part-message.ts"),
        "utf8"
      ),
    },
    {
      name: "services/intake/capture-clarification.ts",
      code: readFileSync(
        join(SRC, "services/intake/capture-clarification.ts"),
        "utf8"
      ),
    },
    {
      name: "routers/capture.ts#answerFollowUp",
      code: start >= 0 && end > start ? capture.slice(start, end) : "",
    },
  ];
}

describe("tripwire: capture parts never reach the agent-turn doors", () => {
  it("scans every unit, and each unit is the code it claims (non-vacuity)", () => {
    const scanned = units();
    expect(scanned).toHaveLength(3);
    for (const u of scanned) expect(u.code.length, u.name).toBeGreaterThan(200);
    expect(scanned[0]!.code).toContain(
      "export async function recordCapturePartMessage"
    );
    expect(scanned[1]!.code).toContain("recordCapturePartMessage(");
    expect(scanned[2]!.code).toContain("claimCaptureQuestion(");
  });

  it("self-check: the scanner sees a forbidden import and call, and ignores comments", () => {
    expect(
      offenders(
        `import { triggerAutoRespond } from "../../utils/trigger-auto-respond.js";`
      )
    ).not.toHaveLength(0);
    expect(
      offenders(`await postChannelMessage({ channelId })`)
    ).not.toHaveLength(0);
    expect(
      offenders(
        `/** never calls triggerAutoRespond */\n// nor postChannelMessage\nconst x = 1;`
      )
    ).toEqual([]);
  });

  it.each(units().map((u) => [u.name, u.code] as const))(
    "%s imports and calls neither triggerAutoRespond nor postChannelMessage",
    (_name, code) => {
      expect(offenders(code)).toEqual([]);
    }
  );
});

describe("wire shape: structure names the persisted question on both outcomes", () => {
  it("the followUp branch persists through the gate, and the plan branch returns null ids", () => {
    const capture = readFileSync(join(SRC, "routers/capture.ts"), "utf8");
    // The gate reads BOTH the caller's suppression and "this capture's question
    // was already answered" (one question per capture).
    expect(capture).toMatch(
      /followUpIsAsked\(\s*structureResult\.followUp,\s*input\.suppressFollowUp === true \|\| clarificationAnswered\s*\)/
    );
    expect(capture).toContain("await persistCaptureQuestion(");
    expect(capture).toMatch(
      /followUpMessageId: null as string \| null,\s*channelId: null as string \| null,/
    );
  });
});

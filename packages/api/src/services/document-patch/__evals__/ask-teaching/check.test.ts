import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAll, checkOutput, type EvalPrompt } from "./check.js";

const here = dirname(fileURLToPath(import.meta.url));
const prompts = JSON.parse(
  readFileSync(resolve(here, "prompts.json"), "utf8")
) as EvalPrompt[];

const ASK = (key: string) =>
  [
    ":::synap-ask",
    "```json",
    JSON.stringify({
      key,
      ask: { mode: "choose", options: [{ label: "A" }, { label: "B" }] },
    }),
    "```",
    "",
    "Which one?",
    ":::",
  ].join("\n");

const GOOD_ASK = (id: string) => `# Doc\n\nContext.\n\n${ASK(id)}\n`;
const GOOD_PLAIN = "# Doc\n\nWhat happened, plainly.\n\n- Done: the thing\n";
const PROSE_Q =
  "# Doc\n\n## Open questions\n\n- Which option do you prefer for the rollout?\n";

describe("ask-teaching eval checker", () => {
  it("the fixture is half asks, half not", () => {
    expect(prompts.filter((p) => p.expectAsk).length).toBe(prompts.length / 2);
  });

  it("a model that behaves passes every prompt", () => {
    const outputs = Object.fromEntries(
      prompts.map((p) => [p.id, p.expectAsk ? GOOD_ASK(p.id) : GOOD_PLAIN])
    );
    const r = checkAll(prompts, outputs);
    expect(r.passed).toBe(r.total);
  });

  it("fails an asking prompt answered in prose", () => {
    const p = prompts.find((x) => x.expectAsk)!;
    expect(checkOutput(p, PROSE_Q).pass).toBe(false);
  });

  it("fails an asking prompt with a broken block", () => {
    const p = prompts.find((x) => x.expectAsk)!;
    const broken =
      ':::synap-ask\n```json\n{"ask":{"mode":"choose","options":[]}}\n```\nQ?\n:::\n';
    const v = checkOutput(p, broken);
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/validate/);
  });

  it("fails a plain prompt that gets an ask or a prose question", () => {
    const p = prompts.find((x) => !x.expectAsk)!;
    expect(checkOutput(p, GOOD_ASK("x")).pass).toBe(false);
    expect(checkOutput(p, PROSE_Q).pass).toBe(false);
  });

  it("fails a missing output", () => {
    expect(checkAll(prompts, {}).passed).toBe(0);
  });
});

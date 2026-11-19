/**
 * Checker for the ask-teaching eval: given what a model WROTE for a prompt in
 * `prompts.json`, did it use an ask block when the document needed the
 * person's decision, and stay out of asks when it did not?
 *
 * Offline by design: it reads the model's output, never calls a model.
 * Run it over real outputs with `ask-teaching/run.ts <outputs.json>`.
 */
import { planAskDefinitions } from "../../materialize-asks.js";
import { findProseQuestion } from "../../ask-nudge.js";

export interface EvalPrompt {
  id: string;
  expectAsk: boolean;
  prompt: string;
}

export interface EvalVerdict {
  id: string;
  pass: boolean;
  reason: string;
}

const ASK_OPEN = /^[ \t]*:{3,}synap-ask\b/gm;

export function checkOutput(
  prompt: EvalPrompt,
  output: string
): EvalVerdict {
  const blocks = (output.match(ASK_OPEN) ?? []).length;
  const plan = planAskDefinitions([output]);
  const valid = plan.ok ? plan.plans.length : 0;
  const prose = findProseQuestion(output);
  const fail = (reason: string): EvalVerdict => ({
    id: prompt.id,
    pass: false,
    reason,
  });
  if (prompt.expectAsk) {
    if (blocks === 0) return fail("needed the person's input but wrote no ask block");
    if (!plan.ok) return fail(`ask block does not validate: ${plan.message}`);
    if (valid === 0) return fail("ask block is a reference, not a definition");
    if (valid > 3) return fail(`${valid} asks in one document (too many)`);
    if (prose) return fail(`also asks in prose: "${prose}"`);
    return { id: prompt.id, pass: true, reason: "one valid ask block" };
  }
  if (blocks > 0) return fail("added an ask nothing needed");
  if (prose) return fail(`question in prose with nothing to decide: "${prose}"`);
  return { id: prompt.id, pass: true, reason: "no ask, no prose question" };
}

export function checkAll(
  prompts: readonly EvalPrompt[],
  outputs: Readonly<Record<string, string>>
): { verdicts: EvalVerdict[]; passed: number; total: number } {
  const verdicts = prompts.map((p) =>
    outputs[p.id] === undefined
      ? { id: p.id, pass: false, reason: "no output for this prompt" }
      : checkOutput(p, outputs[p.id]!)
  );
  return {
    verdicts,
    passed: verdicts.filter((v) => v.pass).length,
    total: verdicts.length,
  };
}

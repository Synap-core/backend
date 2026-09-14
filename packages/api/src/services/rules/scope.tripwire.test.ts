/**
 * The governed rule door ↔ the trigger matcher: ONE project-scope family list.
 *
 * `PROJECT_SCOPE_EVENT_PREFIXES` (`./scope.ts`) decides which compiled WHENs
 * may carry `triggerConfig.projectId`; `RULE_SCOPE_EVENT_PREFIXES.projectId`
 * (`@synap/jobs` automation-trigger-matcher.ts) decides which events a
 * project-scoped rule can fire for. A drift fails in both directions:
 *   - door wider than matcher ⇒ a rule is ACCEPTED as project-limited and then
 *     never fires (the matcher fails closed on the family);
 *   - door narrower ⇒ a rule the runtime could limit is refused.
 *
 * A SOURCE scan because `@synap/api` reads `@synap/jobs` through its built
 * dist — importing the constant would compare against whatever was last built.
 * Blind spot, stated: the literal is parsed as a plain string array; a spread or
 * a constant reference inside it fails the non-vacuity check rather than
 * passing silently.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROJECT_SCOPE_EVENT_PREFIXES,
  bindRuleProjectScope,
  isProjectScopeEnforceable,
} from "./scope.js";

const here = dirname(fileURLToPath(import.meta.url));
// rules → services → src → api → packages
const MATCHER = resolve(
  here,
  "..",
  "..",
  "..",
  "..",
  "jobs/src/workers/automation-trigger-matcher.ts"
);

function readMatcherProjectPrefixes(source: string): string[] | null {
  const literal = source.match(
    /export const RULE_SCOPE_EVENT_PREFIXES\s*=\s*\{([\s\S]*?)\}\s*as const/
  );
  if (!literal) return null;
  const project = literal[1].match(/projectId\s*:\s*\[([^\]]*)\]/);
  if (!project) return null;
  return [...project[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
}

describe("rule door project scope ↔ matcher", () => {
  it("the parser can still read a literal sample (self-check)", () => {
    expect(
      readMatcherProjectPrefixes(
        'export const RULE_SCOPE_EVENT_PREFIXES = {\n  entityId: ["a."],\n  projectId: [\n    "b.",\n    "c.",\n  ],\n} as const;'
      )
    ).toEqual(["b.", "c."]);
  });

  it("mirrors RULE_SCOPE_EVENT_PREFIXES.projectId exactly", () => {
    expect(existsSync(MATCHER), `matcher not found at ${MATCHER}`).toBe(true);
    const matcher = readMatcherProjectPrefixes(readFileSync(MATCHER, "utf8"));
    expect(
      matcher,
      "RULE_SCOPE_EVENT_PREFIXES.projectId not parsed"
    ).not.toBeNull();
    expect(matcher!.length).toBeGreaterThan(0);
    expect([...PROJECT_SCOPE_EVENT_PREFIXES].sort()).toEqual(
      [...matcher!].sort()
    );
  });
});

describe("bindRuleProjectScope", () => {
  const event = (eventPattern: string) => ({
    triggerType: "event",
    triggerConfig: { eventPattern },
  });

  it("no project ⇒ the compiled config, untouched and unlabelled", () => {
    const trigger = event("entity.create.completed");
    const bound = bindRuleProjectScope(trigger, undefined);
    expect(bound).toEqual({ ok: true, triggerConfig: trigger.triggerConfig });
  });

  it("an entity WHEN is stamped and the note says it is limited", () => {
    const trigger = event("entity.create.completed");
    const bound = bindRuleProjectScope(trigger, "proj-1");
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(bound.triggerConfig).toEqual({
      eventPattern: "entity.create.completed",
      projectId: "proj-1",
    });
    expect(bound.scopeNote).toMatch(/runs only for events on project proj-1/);
    // Never mutates the compiler's output.
    expect(trigger.triggerConfig).not.toHaveProperty("projectId");
  });

  it.each([
    ["relation.create.completed"],
    ["message.received"],
    ["capture.complete.completed"],
  ])("REFUSES a project on %s by the WHEN clause", (pattern) => {
    const bound = bindRuleProjectScope(event(pattern), "proj-1");
    expect(bound.ok).toBe(false);
    if (bound.ok) return;
    expect(bound.failure.clause).toBe("WHEN");
    expect(bound.failure.reason).toMatch(/Nothing was saved/);
  });

  it("REFUSES a project on a schedule", () => {
    expect(
      isProjectScopeEnforceable({
        triggerType: "cron",
        triggerConfig: { expression: "0 9 * * *" },
      })
    ).toBe(false);
    expect(
      bindRuleProjectScope(
        { triggerType: "cron", triggerConfig: { expression: "0 9 * * *" } },
        "proj-1"
      ).ok
    ).toBe(false);
  });
});

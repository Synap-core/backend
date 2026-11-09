/**
 * The ONE read of what a playbook, or one of its steps, `requires`: the
 * capability keys a runner's computer must have installed (runner engine spec
 * 7111934d §2.2). Every reader goes through here (the run choice, the Run
 * door's runner mapping, a step's hand-over), so when `requires` becomes
 * derived from the playbook's `tools` (plan 08e4fba7 decision 4, after
 * backend#1002) only this function changes.
 *
 * A step's list is added to the playbook's (a set, first-seen order). Stored
 * jsonb is data: anything that is not a string is ignored. A leaf (no imports).
 */
export function requiresOf(
  playbook: { requires?: unknown } | null | undefined,
  stage?: { requires?: unknown } | null
): string[] {
  return [
    ...new Set([...stringsOf(stage?.requires), ...stringsOf(playbook?.requires)]),
  ];
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((k): k is string => typeof k === "string" && k.length > 0)
    : [];
}

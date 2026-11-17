/**
 * A by-name `playbook_run` node gets its playbook's id at save — the implicit
 * fourth playbook → automation carrier (Process wave plan 0adf8352, W2: one
 * link per relation). A template names its seeded playbook by stable name
 * (`playbookName`) because the runtime id is not known at author time; the
 * automation write doors (`routers/automations.ts`, create and update, beside
 * `injectSkillIdsFromNames`) stamp the id BEFORE the flow is persisted or rides
 * an AI proposal, so a stored automation runs an id a reader can join on. The
 * name stays (template-friendly, and what a person reads).
 *
 * A name matching NO visible playbook is left as-is (the validator refuses it
 * first). A name matching SEVERAL is left as-is too: picking one would be a
 * guess, and the runtime's by-name resolution then decides as it did before.
 * Mutates the flow in place; one lookup for every name in it.
 */
export async function stampPlaybookRunIds(
  flow: { nodes: Array<Record<string, unknown>> },
  lookup: (
    names: readonly string[]
  ) => Promise<ReadonlyArray<{ id: string; name: string }>>
): Promise<void> {
  const pending: Array<{ data: Record<string, unknown>; name: string }> = [];
  for (const node of flow.nodes) {
    if (node?.type !== "playbook_run") continue;
    const data = (node.data ?? {}) as Record<string, unknown>;
    const name =
      typeof data.playbookName === "string" ? data.playbookName.trim() : "";
    const hasId =
      typeof data.playbookId === "string" && data.playbookId.trim().length > 0;
    if (hasId || !name) continue;
    node.data = data;
    pending.push({ data, name });
  }
  if (pending.length === 0) return;
  const rows = await lookup([...new Set(pending.map((p) => p.name))]);
  const idsByName = new Map<string, string[]>();
  for (const r of rows) {
    idsByName.set(r.name, [...(idsByName.get(r.name) ?? []), r.id]);
  }
  for (const p of pending) {
    const ids = idsByName.get(p.name) ?? [];
    if (ids.length === 1) p.data.playbookId = ids[0];
  }
}

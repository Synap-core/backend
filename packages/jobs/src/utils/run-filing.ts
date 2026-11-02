/**
 * Where an automation run's own session is filed (goals that run, R3).
 *
 * A worker enabled on a goal compiles to a rule whose `playbook_run` node
 * carries the goal's filing (`data.projectId` / `data.trackId`, the sentence
 * grammar's `__projectId` / `__trackId`). `runPlaybook` files the PLAYBOOK
 * sessions there; the automation run's own session (opened by the executor
 * for a flow that is more than a single `playbook_run`) must land in the same
 * goal, or the goal never sees its runs.
 *
 * The rule: every `playbook_run` node of the flow that names a goal names the
 * SAME goal, in the same project → that goal. Two goals, or a goal without its
 * project → no goal (the run session keeps its project placement only when
 * the nodes agree on one project). Pure: no DB.
 */
export interface RunFiling {
  projectId: string | null;
  trackId: string | null;
}

export function runFilingOfFlow(flow: {
  nodes: ReadonlyArray<{ type?: string; data?: unknown }>;
}): RunFiling {
  const projects = new Set<string>();
  const tracks = new Set<string>();
  for (const node of flow.nodes) {
    if (node.type !== "playbook_run") continue;
    const data = (node.data ?? {}) as {
      projectId?: unknown;
      trackId?: unknown;
    };
    if (typeof data.projectId === "string" && data.projectId)
      projects.add(data.projectId);
    if (typeof data.trackId === "string" && data.trackId)
      tracks.add(data.trackId);
  }
  const projectId = projects.size === 1 ? [...projects][0]! : null;
  const trackId = projectId && tracks.size === 1 ? [...tracks][0]! : null;
  return { projectId, trackId };
}

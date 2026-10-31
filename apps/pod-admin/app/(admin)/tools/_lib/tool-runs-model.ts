/**
 * A tool page's runs — the pure half of `views/tool-runs.tsx`.
 *
 * What runs for a tool, and where the pod keeps it:
 *   • its ACTIONS' runs — `runs.list` with the tool lens (`scope.capabilityId`
 *     or `scope.skillId`): proposed runs, direct calls, box runs;
 *   • a capability's FLOWS — the rules and templates in it, whose live runs
 *     `runs.recentByFlows` reads.
 * A direct call is stored as one terminal event (`listCapabilityRuns`): it is
 * never "running", it shows in History once done (contract a0f787b7, named
 * silence). So Running now holds box runs and flow runs.
 */

import { resolveToolLabel } from "@synap-core/types/vocabulary";

export interface ActionVerbLike {
  verbId: string;
  label: string;
}

/**
 * An action run's name in words. A run carries its verb id (`flowName`); the
 * capability's card names that verb, so its label wins; anything else goes
 * through the vocabulary's tool door, never the raw token.
 */
export function actionLabelFor(
  verbs: readonly ActionVerbLike[]
): (flowName: string) => string {
  const byId = new Map(verbs.map((v) => [v.verbId, v.label]));
  return (flowName) => byId.get(flowName) ?? resolveToolLabel(flowName, "past");
}

export interface RunningRow {
  key: string;
  flowType: string;
  id: string;
  name: string;
  startedAt: string;
}

function iso(v: string | Date): string {
  return typeof v === "string" ? v : v.toISOString();
}

/**
 * What is running now: the tool's action runs still running, and the running
 * runs of its flows, newest first.
 */
export function runningNow(input: {
  actionRuns: ReadonlyArray<{
    id: string;
    flowName: string;
    status: string;
    startedAt: string | Date;
  }>;
  flows: ReadonlyArray<{ flowType: string; flowId: string; name: string }>;
  histories: ReadonlyArray<{
    flowType: string;
    flowId: string;
    runs: ReadonlyArray<{
      id: string;
      status: string;
      startedAt: string | Date;
    }>;
  }>;
  actionLabel: (flowName: string) => string;
}): RunningRow[] {
  const flowName = new Map(
    input.flows.map((f) => [`${f.flowType}:${f.flowId}`, f.name])
  );
  const rows: RunningRow[] = [
    ...input.actionRuns
      .filter((r) => r.status === "running")
      .map((r) => ({
        key: `capability:${r.id}`,
        flowType: "capability",
        id: r.id,
        name: input.actionLabel(r.flowName),
        startedAt: iso(r.startedAt),
      })),
    ...input.histories.flatMap((h) =>
      h.runs
        .filter((r) => r.status === "running")
        .map((r) => ({
          key: `${h.flowType}:${r.id}`,
          flowType: h.flowType,
          id: r.id,
          name: flowName.get(`${h.flowType}:${h.flowId}`) ?? "",
          startedAt: iso(r.startedAt),
        }))
    ),
  ];
  return rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** The flows a capability holds, as `runs.recentByFlows` takes them. */
export function capabilityFlows(
  members: ReadonlyArray<{ kind: string; id: string; name?: string }>
): Array<{
  flowType: "automation" | "playbook";
  flowId: string;
  name: string;
}> {
  return members.flatMap((m) =>
    m.kind === "automation" || m.kind === "playbook"
      ? [{ flowType: m.kind, flowId: m.id, name: m.name ?? "" }]
      : []
  );
}

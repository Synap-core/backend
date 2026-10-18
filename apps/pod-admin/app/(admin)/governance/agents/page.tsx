"use client";

/**
 * Governance › Agents & work — the agent × work matrix, pod lens
 * (`governanceRules.matrix({ lens: "pod" })`, pod admins only — the `(admin)`
 * proxy gate and the procedure's own `assertPodAdmin`).
 *
 * Rows are agents (type → computer → agent), columns each space's processes,
 * its Other work and the locked platform floors; a cell is what the agent's
 * write WOULD do there, answered by the one governance resolver. Click or
 * Enter on a cell opens WHY.
 *
 * States: skeleton · failed + Retry (a failed read is never an empty matrix) ·
 * INVITE when there are no agents · EXPLAIN when no space has a process ·
 * a banner when the read was `partial`.
 */

import { Button, Snippet } from "@heroui/react";
import { AlertTriangle, Bot, Lock, Workflow } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  AGENT_MATRIX_LIMITS,
  MATRIX_MARKS,
  type MatrixAgentRow,
  type MatrixMark,
} from "@synap-core/types/agent-matrix";
import { resolveMatrixMarkLabel } from "@synap-core/types/vocabulary";
import { trpc } from "../../../../lib/trpc";
import {
  agentRowKey,
  defaultExpanded,
  findRow,
  hasNoProcesses,
  matrixState,
  toggleExpanded,
  visibleRows,
} from "../../../../lib/agent-matrix/matrix-view-model";
import { ResourceRowError } from "../../components/resource-row";
import { PageHeader, PageShell } from "../../components/page-header";
import { MatrixGrid } from "./_lib/matrix-grid";
import { toneTextClass } from "./_lib/mark-tone";
import { WhyDrawer, type WhyTarget } from "./_lib/why-drawer";

const LEGEND: MatrixMark[] = ["auto", "ask", "off", "mixed"];

export default function AgentsAndWorkPage() {
  const query = trpc.governanceRules.matrix.useQuery(
    { lens: "pod" },
    { staleTime: 30_000 }
  );
  const state = matrixState(query);
  const matrix = query.data;

  // Small pods open expanded; once the person toggles, their choice rules.
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [why, setWhy] = useState<{ rowKey: string; columnId: string } | null>(
    null
  );

  const view = useMemo(
    () =>
      matrix
        ? visibleRows(matrix, expanded ?? defaultExpanded(matrix), showAll)
        : null,
    [matrix, expanded, showAll]
  );

  // The drawer holds keys, so a refetch after Widen / Revoke redraws it fresh.
  const whyTarget: WhyTarget | null = useMemo(() => {
    if (!why || !matrix) return null;
    const row = findRow(matrix, why.rowKey);
    const column = matrix.columns.find((c) => c.id === why.columnId);
    return row && column ? { row, column } : null;
  }, [why, matrix]);

  return (
    <PageShell>
      <PageHeader
        title="Agents & work"
        description="What each agent may do in each space's work — and why."
      />

      {state === "loading" && <MatrixSkeleton />}

      {state === "failed" && (
        <div className="rounded-lg ring-1 ring-inset ring-foreground/10">
          <ResourceRowError
            message="Couldn't load the agents and their work."
            onRetry={() => void query.refetch()}
          />
        </div>
      )}

      {state === "no-agents" && <NoAgents />}

      {state === "ready" && matrix && view && (
        <div className="flex flex-col gap-4">
          {matrix.partial && (
            <p
              role="status"
              className="flex items-start gap-2 rounded-lg bg-status-stale/10 px-3 py-2 text-[12.5px] text-status-stale ring-1 ring-inset ring-status-stale/30"
            >
              <AlertTriangle
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
                aria-hidden
              />
              <span>
                Part of the pod is left out: {matrix.partial.agentsOmitted}{" "}
                agents and {matrix.partial.columnsOmitted} columns past the
                limit of {AGENT_MATRIX_LIMITS.agents} agents ×{" "}
                {AGENT_MATRIX_LIMITS.columns} columns.
              </span>
            </p>
          )}

          {hasNoProcesses(matrix) && <NoProcesses />}

          <Legend />

          <MatrixGrid
            matrix={matrix}
            rows={view.rows}
            onToggle={(key) =>
              setExpanded((prev) =>
                toggleExpanded(prev ?? defaultExpanded(matrix), key)
              )
            }
            onWhy={(row, column) =>
              setWhy({ rowKey: row.key, columnId: column.id })
            }
          />

          {view.hiddenTypeGroups > 0 && (
            <div>
              <Button
                size="sm"
                variant="flat"
                radius="md"
                onPress={() => setShowAll(true)}
              >
                Show all {matrix.groups.length} agent types
              </Button>
            </div>
          )}
        </div>
      )}

      <WhyDrawer
        target={whyTarget}
        onClose={() => setWhy(null)}
        onOpenAgent={(agent: MatrixAgentRow) =>
          why &&
          setWhy({
            rowKey: agentRowKey(agent.agentUserId),
            columnId: why.columnId,
          })
        }
        onChanged={() => void query.refetch()}
      />
    </PageShell>
  );
}

function Legend() {
  return (
    <ul
      aria-label="Marks"
      className="flex flex-wrap items-center gap-4 text-[12px] text-foreground/70"
    >
      {LEGEND.map((mark) => (
        <li key={mark} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={[
              "text-[14px]",
              toneTextClass(MATRIX_MARKS[mark].tone),
            ].join(" ")}
          >
            {MATRIX_MARKS[mark].glyph}
          </span>
          {resolveMatrixMarkLabel(mark)}
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <Lock className="h-3 w-3" aria-hidden />
        Platform limit
      </li>
    </ul>
  );
}

/** INVITE — the person fills it themselves, from a computer. */
function NoAgents() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg px-6 py-12 text-center ring-1 ring-inset ring-foreground/10">
      <Bot className="h-6 w-6 text-foreground/40" aria-hidden />
      <div className="flex flex-col gap-1">
        <p className="text-[14px] font-medium text-foreground">No agents yet</p>
        <p className="max-w-md text-[12.5px] text-foreground/65">
          Connect one from a computer. Each agent it sets up shows here with
          what it may do in every space.
        </p>
      </div>
      <Snippet symbol="" size="sm" className="font-mono">
        synap init
      </Snippet>
    </div>
  );
}

/** EXPLAIN — only installing or writing a process fills the process columns. */
function NoProcesses() {
  return (
    <div className="flex items-start gap-3 rounded-lg px-4 py-3 ring-1 ring-inset ring-foreground/10">
      <Workflow
        className="mt-0.5 h-4 w-4 shrink-0 text-foreground/40"
        aria-hidden
      />
      <div className="flex flex-1 flex-col gap-0.5">
        <p className="text-[13px] font-medium text-foreground">
          No processes yet
        </p>
        <p className="text-[12px] text-foreground/65">
          A process is a playbook that works a kind&apos;s lifecycle; each gets
          its own column here. Until then, Other work shows what each agent may
          do in each space.
        </p>
      </div>
      <Button
        as={Link}
        href="/marketplace"
        size="sm"
        variant="flat"
        radius="md"
      >
        Browse templates
      </Button>
    </div>
  );
}

function MatrixSkeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-lg p-3 ring-1 ring-inset ring-foreground/10">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="h-4 w-48 rounded bg-foreground/10 shimmer-pulse" />
          {Array.from({ length: 5 }).map((__, j) => (
            <div
              key={j}
              className="h-4 w-16 rounded bg-foreground/[0.07] shimmer-pulse"
            />
          ))}
        </div>
      ))}
    </div>
  );
}

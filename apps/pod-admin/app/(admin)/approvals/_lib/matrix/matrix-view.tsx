"use client";

/**
 * Approvals › By work — the agent × work matrix, folded into Approvals
 * (decision b387ca45 D5; it was Governance › Agents & work). One read,
 * `governanceRules.matrix({ lens: "pod" })` (pod admins only — the `(admin)`
 * proxy gate and the procedure's own `assertPodAdmin`):
 *
 *   ?view=work             the pod default, the agents (how each one's writes
 *                          land, its page, "Why, per space") and every agent ×
 *                          each space's processes, its Other work and the
 *                          locked platform floors (type → computer → agent);
 *   ?view=work&agent=<id>  that agent's row of the grid alone, each cell
 *                          opening WHY (Widen / Revoke).
 *
 * The page's header and its one filter row are the Approvals page's. States:
 * skeleton · failed + Retry (a failed read is never an empty matrix) · INVITE
 * when there are no agents · EXPLAIN when no space has a process or when the
 * asked-for agent is not in the read · a banner when the read was `partial`.
 */

import { Button, Snippet } from "@heroui/react";
import { AlertTriangle, Bot, Lock, Workflow } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  AGENT_MATRIX_LIMITS,
  MATRIX_MARKS,
  type AgentMatrix,
  type MatrixAgentRow,
  type MatrixMark,
} from "@synap-core/types/agent-matrix";
import { resolveMatrixMarkLabel } from "@synap-core/types/vocabulary";
import { trpc } from "../../../../../lib/trpc";
import { agentHref } from "../../../../../lib/console-nav";
import { useT } from "../../../../../lib/i18n/locale-provider";
import {
  agentOnlyRows,
  agentRowKey,
  agentsAndWorkHref,
  defaultExpanded,
  findRow,
  hasNoProcesses,
  matrixAgents,
  matrixState,
  toggleExpanded,
  visibleRows,
  type MatrixRow,
} from "../../../../../lib/agent-matrix/matrix-view-model";
import { ResourceRowError } from "../../../components/resource-row";
import { AgentList, PodDefaultLine } from "./agent-list";
import { en, fr } from "./copy";
import { MatrixGrid } from "./matrix-grid";
import { toneTextClass } from "./mark-tone";
import { WhyDrawer, type WhyTarget } from "./why-drawer";

const CATALOGS = { en, fr };
const LEGEND: MatrixMark[] = ["auto", "ask", "off", "mixed"];

export function ApprovalsGrid({
  agentId,
  base,
}: {
  /** `?agent=`: that agent's row alone. */
  agentId: string | null;
  /** The Approvals page's own path, for the agents' "Why, per space" doors. */
  base: string;
}) {
  const t = useT(CATALOGS);
  const query = trpc.governanceRules.matrix.useQuery(
    { lens: "pod" },
    { staleTime: 30_000 }
  );
  const state = matrixState(query);
  const matrix = query.data;

  return (
    <>
      {state === "loading" && <MatrixSkeleton />}

      {state === "failed" && (
        <div className="rounded-lg ring-1 ring-inset ring-foreground/10">
          <ResourceRowError
            message={t("failed")}
            onRetry={() => void query.refetch()}
          />
        </div>
      )}

      {state === "no-agents" && <NoAgents />}

      {state === "ready" && matrix && (
        <div className="flex flex-col gap-4">
          {matrix.partial && <PartialBanner partial={matrix.partial} />}
          {agentId ? (
            <OneAgentGrid
              matrix={matrix}
              agentUserId={agentId}
              onRefetch={() => void query.refetch()}
            />
          ) : (
            <>
              <PodDefaultLine />
              <AgentList
                agents={matrixAgents(matrix)}
                whyHref={(id) => agentsAndWorkHref(base, { agentUserId: id })}
              />
              <WholeGrid
                matrix={matrix}
                onRefetch={() => void query.refetch()}
              />
            </>
          )}
        </div>
      )}
    </>
  );
}

function PartialBanner({
  partial,
}: {
  partial: NonNullable<AgentMatrix["partial"]>;
}) {
  return (
    <p
      role="status"
      className="flex items-start gap-2 rounded-lg bg-status-stale/10 px-3 py-2 text-[12.5px] text-status-stale ring-1 ring-inset ring-status-stale/30"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        Part of the pod is left out: {partial.agentsOmitted} agents and{" "}
        {partial.columnsOmitted} columns past the limit of{" "}
        {AGENT_MATRIX_LIMITS.agents} agents × {AGENT_MATRIX_LIMITS.columns}{" "}
        columns.
      </span>
    </p>
  );
}

/** The why-drawer, held by keys so a refetch after Widen / Revoke redraws it fresh. */
function useWhy(matrix: AgentMatrix) {
  const [why, setWhy] = useState<{ rowKey: string; columnId: string } | null>(
    null
  );
  const whyTarget: WhyTarget | null = useMemo(() => {
    if (!why) return null;
    const row = findRow(matrix, why.rowKey);
    const column = matrix.columns.find((c) => c.id === why.columnId);
    return row && column ? { row, column } : null;
  }, [why, matrix]);
  return { why, setWhy, whyTarget };
}

/** `?agent=<id>`: that agent's row alone. */
function OneAgentGrid({
  matrix,
  agentUserId,
  onRefetch,
}: {
  matrix: AgentMatrix;
  agentUserId: string;
  onRefetch: () => void;
}) {
  const t = useT(CATALOGS);
  const rows = useMemo(
    () => agentOnlyRows(matrix, agentUserId),
    [matrix, agentUserId]
  );
  const { why, setWhy, whyTarget } = useWhy(matrix);

  if (!rows) {
    // EXPLAIN — never an empty grid that reads as "it may do nothing".
    return (
      <div className="flex flex-col gap-1 rounded-lg px-4 py-3 ring-1 ring-inset ring-foreground/10">
        <p className="text-[13px] font-medium text-foreground">
          {t("agent.missing")}
        </p>
        <p className="text-[12px] text-foreground/65">
          {t("agent.missingHint")}
        </p>
      </div>
    );
  }
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Legend />
        <Button
          as={Link}
          href={agentHref(agentUserId)}
          size="sm"
          variant="flat"
          radius="md"
        >
          {t("agent.page")}
        </Button>
      </div>
      {hasNoProcesses(matrix) && <NoProcesses />}
      <MatrixGrid
        matrix={matrix}
        rows={rows}
        // A lone agent row has no group to open or close.
        onToggle={() => {}}
        onWhy={(row: MatrixRow, column) =>
          setWhy({ rowKey: row.key, columnId: column.id })
        }
      />
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
        onChanged={onRefetch}
      />
    </>
  );
}

/** `?view=work`: every agent, grouped type → computer → agent. */
function WholeGrid({
  matrix,
  onRefetch,
}: {
  matrix: AgentMatrix;
  onRefetch: () => void;
}) {
  // Small pods open expanded; once the person toggles, their choice rules.
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const [showAll, setShowAll] = useState(false);
  const { why, setWhy, whyTarget } = useWhy(matrix);
  const view = useMemo(
    () => visibleRows(matrix, expanded ?? defaultExpanded(matrix), showAll),
    [matrix, expanded, showAll]
  );

  return (
    <>
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
        onChanged={onRefetch}
      />
    </>
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

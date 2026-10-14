"use client";

/**
 * WHY — the matrix cell's drawer (the shared `DetailDrawer`).
 *
 * An agent's cell: per probe, the verdict as a mark, the rung that decided in
 * words (`resolveGovernanceRungLabel`) with the resolver's reason under it, the
 * rule that decided as a door (+ Revoke), and ONE primary action — Widen,
 * which files the narrowest rule (`governanceRules.widenCell`): a rule now on
 * your own agent, a proposal to its owner on anyone else's (decision 8).
 *
 * A group's cell: its members, each a door to its own WHY — a group has no
 * verdict of its own, only a split.
 */

import { Button, addToast } from "@heroui/react";
import { AlertTriangle, Check, Lock, Pause, User } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  MATRIX_MARKS,
  type MatrixAgentRow,
  type MatrixColumn,
} from "@synap-core/types/agent-matrix";
import {
  isNoNextRungError,
  resolveNextRungOutcomeView,
  type NextRungOutcome,
} from "@synap-core/types/trust-ladder";
import {
  resolveGovernanceRungLabel,
  resolveMatrixMarkLabel,
} from "@synap-core/types/vocabulary";
import { trpc } from "../../../../../lib/trpc";
import {
  columnTitle,
  combineWidenOutcomes,
  markView,
  probeViews,
  ruleHref,
  widenPlan,
  type MatrixRow,
} from "../../../../../lib/agent-matrix/matrix-view-model";
import { ConfirmModal } from "../../../components/confirm-modal";
import { DetailDrawer } from "../../../components/detail-drawer";
import { toneTextClass } from "./mark-tone";

export interface WhyTarget {
  row: MatrixRow;
  column: MatrixColumn;
}

/** How many members a group's drawer lists before "Show all". */
const MEMBER_CAP = 12;

export function WhyDrawer({
  target,
  onClose,
  onOpenAgent,
  onChanged,
}: {
  target: WhyTarget | null;
  onClose: () => void;
  onOpenAgent: (agent: MatrixAgentRow) => void;
  onChanged: () => void;
}) {
  const cell = target ? target.row.cells[target.column.id] : undefined;
  const mark = cell ? markView(cell) : null;
  return (
    <DetailDrawer
      isOpen={!!target}
      onClose={onClose}
      title={target?.row.label ?? ""}
      subtitle={target ? columnTitle(target.column) : undefined}
      headerRight={
        mark ? (
          <span className="flex items-center gap-1.5 text-[12px] text-foreground/70">
            <span className={["text-[15px]", toneTextClass(mark.tone)].join(" ")} aria-hidden>
              {mark.glyph}
            </span>
            {mark.splitWords ? `${mark.label}: ${mark.splitWords}` : mark.label}
          </span>
        ) : undefined
      }
    >
      {target && target.row.agent ? (
        <AgentWhy
          // A fresh cell resets the widen result and any open confirm.
          key={`${target.row.key}|${target.column.id}`}
          agent={target.row.agent}
          column={target.column}
          onChanged={onChanged}
        />
      ) : target ? (
        <GroupWhy target={target} onOpenAgent={onOpenAgent} />
      ) : null}
    </DetailDrawer>
  );
}

function AgentWhy({
  agent,
  column,
  onChanged,
}: {
  agent: MatrixAgentRow;
  column: MatrixColumn;
  onChanged: () => void;
}) {
  const cell = agent.cells[column.id];
  const probes = useMemo(
    () => (cell ? probeViews(column, cell) : []),
    [column, cell]
  );
  const plan = widenPlan(agent, probes);
  const [result, setResult] = useState<NextRungOutcome | "failed" | null>(null);
  const [widening, setWidening] = useState(false);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const widen = trpc.governanceRules.widenCell.useMutation();
  const revoke = trpc.governanceRules.revoke.useMutation({
    onSuccess: () => {
      addToast({ title: "Rule revoked", color: "default" });
      setRevokeId(null);
      onChanged();
    },
    onError: (err) =>
      addToast({ title: "Revoke failed", description: err.message, color: "danger" }),
  });

  async function onWiden() {
    if (!plan) return;
    setWidening(true);
    const outcomes: Array<NextRungOutcome | "failed"> = [];
    for (const probe of plan.probes) {
      try {
        const r = await widen.mutateAsync({
          agentUserId: agent.agentUserId,
          workspaceId: column.workspaceId,
          action: probe.action,
          profileSlug: probe.profileSlug,
        });
        outcomes.push(r.outcome);
      } catch (err) {
        // "Nothing to widen" withdraws the offer and claims nothing.
        if (!isNoNextRungError(err)) outcomes.push("failed");
      }
    }
    setWidening(false);
    setResult(combineWidenOutcomes(outcomes));
    onChanged();
  }

  const outcome = result ? resolveNextRungOutcomeView(result) : null;
  const OutcomeIcon =
    outcome?.glyph === "alert" ? AlertTriangle : outcome?.glyph === "person" ? User : Check;
  const ruleLink = ruleHref(column.workspaceId);

  return (
    <div className="flex flex-col gap-4">
      {agent.paused && (
        <p className="flex items-center gap-2 text-[12.5px] text-status-stale">
          <Pause className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Paused — it takes no work until someone resumes it.
        </p>
      )}
      {column.kind === "floors" && (
        <p className="flex items-center gap-2 text-[12.5px] text-foreground/70">
          <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Platform limits. No rule can widen them.
        </p>
      )}

      <ul className="flex flex-col divide-y divide-foreground/[0.06]">
        {probes.map((p) => {
          const m = MATRIX_MARKS[p.answer.verdict];
          return (
            <li key={p.probe.key} className="flex flex-col gap-1 py-3">
              <div className="flex items-center gap-2">
                <span aria-hidden className={["w-4 text-[14px]", toneTextClass(m.tone)].join(" ")}>
                  {m.glyph}
                </span>
                <span className="flex-1 text-[13px] font-medium text-foreground">{p.title}</span>
                <span className="text-[12px] text-foreground/70">
                  {resolveMatrixMarkLabel(p.answer.verdict)}
                </span>
              </div>
              <p className="pl-6 text-[12px] text-foreground/70">
                Decided by: {resolveGovernanceRungLabel(p.answer.rung)}
              </p>
              <p className="pl-6 text-[11.5px] text-foreground/50">{p.answer.reason}</p>
              {p.answer.ruleId && (
                <div className="flex items-center gap-2 pl-6 pt-1">
                  {ruleLink && (
                    <Button as={Link} href={ruleLink} size="sm" variant="flat" radius="md">
                      Open rule
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="light"
                    color="danger"
                    radius="md"
                    onPress={() => setRevokeId(p.answer.ruleId)}
                  >
                    Revoke
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {(plan || outcome) && (
        <div className="flex flex-wrap items-center gap-3 border-t border-foreground/[0.06] pt-4">
          {plan && (
            <Button
              color="primary"
              radius="md"
              isLoading={widening}
              isDisabled={result !== null}
              onPress={() => void onWiden()}
            >
              {plan.label}
            </Button>
          )}
          {outcome && (
            <span
              role="status"
              className={["flex items-center gap-1.5 text-[12.5px]", toneTextClass(outcome.tone)].join(" ")}
            >
              <OutcomeIcon className="h-3.5 w-3.5" aria-hidden />
              {outcome.label}
            </span>
          )}
        </div>
      )}

      <ConfirmModal
        isOpen={revokeId !== null}
        onClose={() => setRevokeId(null)}
        onConfirm={() => revokeId && revoke.mutate({ id: revokeId })}
        title="Revoke this rule?"
        consequence="The agent asks first again for everything this rule allowed, in every cell it decided. You can widen it again later."
        confirmLabel="Revoke rule"
        isPending={revoke.isPending}
      />
    </div>
  );
}

function GroupWhy({
  target,
  onOpenAgent,
}: {
  target: WhyTarget;
  onOpenAgent: (agent: MatrixAgentRow) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const members = showAll
    ? target.row.members
    : target.row.members.slice(0, MEMBER_CAP);
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col divide-y divide-foreground/[0.06]">
        {members.map((a) => {
          const c = a.cells[target.column.id];
          const m = c ? markView(c) : null;
          return (
            <li key={a.agentUserId}>
              <button
                type="button"
                onClick={() => onOpenAgent(a)}
                className="flex w-full items-center gap-2 py-2.5 text-left outline-none hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-primary"
              >
                <span aria-hidden className={["w-4 text-[14px]", m ? toneTextClass(m.tone) : ""].join(" ")}>
                  {m?.glyph}
                </span>
                <span className="flex-1 truncate text-[13px] text-foreground">{a.name}</span>
                <span className="text-[12px] text-foreground/70">
                  {m ? (m.splitWords ? `${m.label}: ${m.splitWords}` : m.label) : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {target.row.members.length > MEMBER_CAP && !showAll && (
        <Button size="sm" variant="light" radius="md" onPress={() => setShowAll(true)}>
          Show all {target.row.members.length}
        </Button>
      )}
    </div>
  );
}

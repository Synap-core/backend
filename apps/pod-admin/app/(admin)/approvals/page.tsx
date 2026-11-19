"use client";

/**
 * Approvals — the ONE place pod admin edits who × what × where → runs on its
 * own / asks first / never (decision b387ca45 D5, founder 19 Nov 2026). Every
 * way of answering lands here: "Always approve…" / "Always reject…" and "Next
 * time, do it and tell me" on a request, a playbook pre-approval, a tool's run
 * mode, an agent's posture, a pod default, Widen in the grid. Each row says
 * where it came from (a door to it) and how it is taken back.
 *
 *   (list)        every active `governance_rules` row the reader can see
 *                 (`governanceRules.listAll`: pod rows and the reader's
 *                 spaces), newest first, narrowed by ONE filter row: agent,
 *                 tool, verdict, space (`approvals-model.ts`);
 *   ?view=grid    the agent × work matrix (it was Governance › Agents &
 *                 work; `/governance/agents` redirects here), `?agent=`
 *                 narrowing it to one agent's row.
 *
 * Taking a row back is `governanceRules.revoke` (the pod re-checks who may);
 * a pod default is changed by its switch and a posture row on its agent's
 * page, so a revoke here never fights the setting that wrote it. Receivers:
 * `?agent=`, `?tool=`, `?verdict=`, `?space=`, `?view=`, `?focus=<row id>`.
 */

import { Button, addToast } from "@heroui/react";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import {
  APPROVALS_TITLE,
  humanizePrincipal,
  humanizeScope,
  ruleTitle,
} from "@synap-core/types/governance-rules";
import {
  humanizeToken,
  resolveActionRunModeLabel,
} from "@synap-core/types/vocabulary";
import { trpc } from "../../../lib/trpc";
import { navHref } from "../../../lib/console-nav";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import { readableError } from "../../../lib/format";
import { useT } from "../../../lib/i18n/locale-provider";
import { useReplaceParams } from "../../../lib/use-replace-params";
import {
  buildConnectionLabelLookup,
  type GovernanceRuleRow,
} from "../../../lib/governance-rules/rule-view-model";
import {
  APPROVAL_VERDICTS,
  POD_SPACE,
  approvalAgentKey,
  approvalMatches,
  approvalMode,
  approvalSpaceKey,
  approvalToolKey,
  filterValues,
} from "../../../lib/governance-rules/approvals-model";
import { matrixAgents } from "../../../lib/agent-matrix/matrix-view-model";
import { ConfirmModal } from "../components/confirm-modal";
import {
  FilterChip,
  ListCard,
  ListToolbar,
  PageHeader,
} from "../components/list-page";
import { PageFallback, PageShell } from "../components/page-header";
import { SegmentedChoice } from "../components/segmented-choice";
import { useFocusRow } from "../components/use-focus-row";
import { en, fr } from "./_lib/copy";
import { ApprovalLine, MODE_ICON, MODE_TONE } from "./_lib/approval-line";
import { ApprovalsGrid } from "./_lib/matrix/matrix-view";

const CATALOGS = { en, fr };
const BASE = navHref("approvals");
/** Rows drawn before "Show N more" (lists are capped, ui-composition §4). */
const FIRST_ROWS = 50;

type View = "list" | "grid";

export default function ApprovalsPage() {
  return (
    <Suspense fallback={<PageFallback />}>
      <ApprovalsInner />
    </Suspense>
  );
}

function ApprovalsInner() {
  const t = useT(CATALOGS);
  const params = useSearchParams();
  const replaceParams = useReplaceParams();
  const view: View = params.get("view") === "grid" ? "grid" : "list";
  const filters = {
    agent: params.get("agent"),
    tool: params.get("tool"),
    verdict: params.get("verdict"),
    space: params.get("space"),
  };

  const rules = trpc.governanceRules.listAll.useQuery(undefined, {
    staleTime: 30_000,
    enabled: view === "list",
  });
  // The grid's agents, for the Agent chip when the grid is shown.
  const matrix = trpc.governanceRules.matrix.useQuery(
    { lens: "pod" },
    { staleTime: 30_000, enabled: view === "grid" }
  );
  const spaces = trpc.workspaces.adminListAll.useQuery(undefined, {
    staleTime: 60_000,
  });
  const all: GovernanceRuleRow[] = useMemo(
    () => rules.data?.rules ?? [],
    [rules.data]
  );
  // A connection rule names a registry row: its provider, never the uuid.
  const connections = trpc.connectors.allConnections.useQuery(undefined, {
    enabled: all.some((r) => r.targetKind === "connection"),
  });
  const connectionLabel = useMemo(
    () => buildConnectionLabelLookup(connections.data ?? []),
    [connections.data]
  );

  useEffect(() => {
    if (rules.error) redirectToLoginIfUnauthorized(rules.error);
  }, [rules.error]);

  const spaceName = useMemo(() => {
    const byId = new Map((spaces.data ?? []).map((s) => [s.id, s.name]));
    return (id: string) => byId.get(id);
  }, [spaces.data]);
  const whereOf = (row: GovernanceRuleRow) =>
    approvalSpaceKey(row) === POD_SPACE
      ? t("space.pod")
      : humanizeScope(row, spaceName(row.workspaceId ?? ""));

  const shown = all.filter((r) => approvalMatches(r, filters));
  const [expanded, setExpanded] = useState(false);
  const focusId = useFocusRow({ ready: !rules.isLoading });
  const focusIndex = focusId ? shown.findIndex((r) => r.id === focusId) : -1;
  const drawn =
    expanded || focusIndex >= FIRST_ROWS ? shown : shown.slice(0, FIRST_ROWS);

  // Each chip's values come from the rows (or the grid's agents).
  const agentOptions =
    view === "grid"
      ? matrix.data
        ? matrixAgents(matrix.data).map(({ agent }) => ({
            id: agent.agentUserId,
            label: agent.name,
          }))
        : []
      : filterValues(all, approvalAgentKey).map((v) => ({
          id: v.id,
          label: humanizePrincipal(v.sample),
          count: v.count,
        }));
  const toolOptions = filterValues(all, approvalToolKey).map((v) => ({
    id: v.id,
    label: humanizeToken(v.id),
    count: v.count,
  }));
  const verdictOptions = APPROVAL_VERDICTS.map((v) => {
    const mode = approvalMode(v);
    return {
      id: v,
      label: resolveActionRunModeLabel(mode),
      count: all.filter((r) => r.verdict === v).length,
      icon: MODE_ICON[mode],
      tone: MODE_TONE[mode],
    };
  });
  const spaceOptions = filterValues(all, approvalSpaceKey).map((v) => ({
    id: v.id,
    label:
      v.id === POD_SPACE
        ? t("space.pod")
        : (spaceName(v.id) ?? t("space.unknown")),
    count: v.count,
  }));

  const [pending, setPending] = useState<GovernanceRuleRow | null>(null);
  const [actError, setActError] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const revoke = trpc.governanceRules.revoke.useMutation();
  const titleOf = (row: GovernanceRuleRow) =>
    ruleTitle(row, { connectionLabel });

  async function confirmTakeBack() {
    if (!pending) return;
    setActError(null);
    try {
      await revoke.mutateAsync({ id: pending.id });
      addToast({
        title: t("takeBack.done", { what: titleOf(pending) }),
        color: "default",
      });
      setPending(null);
      await Promise.all([
        utils.governanceRules.listAll.invalidate(),
        utils.governanceRules.matrix.invalidate(),
      ]);
    } catch (err) {
      // The pod's refusal, as it said it: who may take a row back is its call.
      setActError(
        readableError(err instanceof Error ? err.message : null) ??
          t("takeBack.failed")
      );
    }
  }

  const viewSwitch = (
    <SegmentedChoice<View>
      ariaLabel={t("view.label")}
      options={[
        { key: "list", label: t("view.list") },
        { key: "grid", label: t("view.grid") },
      ]}
      active={view}
      onSelect={(next) =>
        replaceParams((p) => {
          if (next === "grid") p.set("view", "grid");
          else p.delete("view");
        })
      }
    />
  );

  return (
    <PageShell>
      <PageHeader title={APPROVALS_TITLE} description={t("description")} />

      <ListToolbar
        filters={
          <>
            <FilterChip
              label={t("filter.agent")}
              allLabel={t("filter.anyAgent")}
              param="agent"
              value={filters.agent}
              options={agentOptions}
            />
            {view === "list" && (
              <>
                <FilterChip
                  label={t("filter.tool")}
                  allLabel={t("filter.anyTool")}
                  param="tool"
                  value={filters.tool}
                  options={toolOptions}
                />
                <FilterChip
                  label={t("filter.verdict")}
                  allLabel={t("filter.anyVerdict")}
                  param="verdict"
                  value={filters.verdict}
                  options={verdictOptions}
                />
                <FilterChip
                  label={t("filter.space")}
                  allLabel={t("filter.anySpace")}
                  param="space"
                  value={filters.space}
                  options={spaceOptions}
                />
              </>
            )}
          </>
        }
        tabs={viewSwitch}
      />

      {view === "grid" ? (
        <ApprovalsGrid agentId={filters.agent} base={BASE} />
      ) : (
        <ListCard
          title={t("list.title")}
          count={rules.isLoading || rules.isError ? null : shown.length}
          loading={rules.isLoading}
          isError={rules.isError}
          onRetry={() => void rules.refetch()}
          errorMessage={t("list.failed")}
          rowCount={shown.length}
          emptyMessage={
            all.length === 0 ? t("list.empty") : t("list.emptyFiltered")
          }
          skeletonRows={5}
          footer={
            drawn.length < shown.length ? (
              <div className="px-1 pt-3">
                <Button
                  size="sm"
                  variant="light"
                  radius="md"
                  onPress={() => setExpanded(true)}
                >
                  {t("list.more", { count: shown.length - drawn.length })}
                </Button>
              </div>
            ) : undefined
          }
        >
          <div className="-mx-2 divide-y divide-foreground/[0.05]">
            {drawn.map((row) => (
              <ApprovalLine
                key={row.id}
                row={row}
                title={titleOf(row)}
                where={whereOf(row)}
                onTakeBack={() => {
                  setActError(null);
                  setPending(row);
                }}
              />
            ))}
          </div>
        </ListCard>
      )}

      <ConfirmModal
        isOpen={pending !== null}
        onClose={() => {
          if (revoke.isPending) return;
          setPending(null);
          setActError(null);
        }}
        onConfirm={() => void confirmTakeBack()}
        title={t("takeBack.title", {
          what: pending ? titleOf(pending) : "",
        })}
        consequence={
          pending?.verdict === "auto"
            ? t("takeBack.auto", { who: humanizePrincipal(pending) })
            : pending?.verdict === "deny"
              ? t("takeBack.deny", { who: humanizePrincipal(pending) })
              : pending
                ? t("takeBack.propose")
                : null
        }
        confirmLabel={t("takeBack.label")}
        confirmColor="warning"
        isPending={revoke.isPending}
      >
        {actError && (
          <p className="text-[12.5px] text-status-down">{actError}</p>
        )}
      </ConfirmModal>
    </PageShell>
  );
}

"use client";

/**
 * An agent's own approvals, under its posture in "What it may do" (lane W3,
 * decision b387ca45 §5): the approval rows for THIS agent, read from
 * `governanceRules.listAll` (the same rows Approvals lists, no store of its
 * own), each with a door to its tool, a door to the row on Approvals, and its
 * way back. Its posture's rows are the posture control above, and a copy on
 * its computer goes with the approval it copies, so neither is listed twice
 * (`agentOwnRows`). A read that failed says so with a retry, never "none".
 */

import { Button } from "@heroui/react";
import Link from "next/link";
import { useMemo } from "react";
import {
  APPROVALS_TITLE,
  humanizeScope,
} from "@synap-core/types/governance-rules";
import { trpc } from "../../../../lib/trpc";
import { navHref } from "../../../../lib/console-nav";
import {
  approvalTitle,
  toolNamesOf,
} from "../../../../lib/governance-rules/approvals-model";
import type { GovernanceRuleRow } from "../../../../lib/governance-rules/rule-view-model";
import {
  agentOwnRows,
  toolIndex,
} from "../../../../lib/governance-rules/tool-approvals-model";
import { ApprovalLine } from "../../../(admin)/approvals/_lib/approval-line";
import { useTakeBack } from "../../../(admin)/approvals/_lib/use-take-back";
import {
  CAPABILITY_READ_OPTIONS,
  CATALOG_INPUT,
  capabilityPageHref,
} from "../../../(admin)/tools/_lib/tools-model";
import { objectViewsT } from "./copy";

/** Rows drawn before "All its approvals" (lists are capped, ui-composition §4). */
const FIRST_ROWS = 8;

export function AgentApprovals({
  agentUserId,
  readOnly,
}: {
  agentUserId: string;
  /** A member's view: words only, no doors into the console, no way back. */
  readOnly: boolean;
}) {
  const t = objectViewsT();
  const rules = trpc.governanceRules.listAll.useQuery(undefined, {
    staleTime: 30_000,
    retry: false,
  });
  const rows = useMemo(
    () =>
      agentOwnRows(
        (rules.data?.rules ?? []) as GovernanceRuleRow[],
        agentUserId
      ),
    [rules.data, agentUserId]
  );
  const namesTools = rows.some((r) => r.targetKind === "capability");
  const catalog = trpc.capabilities.catalog.useQuery(CATALOG_INPUT, {
    ...CAPABILITY_READ_OPTIONS,
    enabled: namesTools,
  });
  const compositions = trpc.capabilities.compositions.useQuery(undefined, {
    ...CAPABILITY_READ_OPTIONS,
    enabled: namesTools,
  });
  const spaces = trpc.workspaces.list.useQuery(undefined, {
    enabled: rows.some((r) => r.scopeKind === "workspace"),
    retry: false,
  });
  const toolName = useMemo(
    () => toolNamesOf(catalog.data ?? [], compositions.data ?? []),
    [catalog.data, compositions.data]
  );
  const index = useMemo(
    () => toolIndex(catalog.data ?? [], compositions.data ?? []),
    [catalog.data, compositions.data]
  );
  const titleOf = (row: GovernanceRuleRow) => approvalTitle(row, { toolName });
  const takeBack = useTakeBack<GovernanceRuleRow>(titleOf);
  const whereOf = (row: GovernanceRuleRow) =>
    humanizeScope(
      row,
      (spaces.data ?? []).find((s) => s.id === row.workspaceId)?.name
    );
  const approvalsBase = navHref("approvals");
  const allHref = `${approvalsBase}?agent=${encodeURIComponent(agentUserId)}`;

  let body;
  if (rules.isError) {
    body = (
      <div
        data-approvals-failed=""
        className="flex flex-wrap items-center gap-3"
      >
        <p className="text-[12.5px] text-status-down">
          {t("agent.approvals.failed")}
        </p>
        <Button
          size="sm"
          variant="flat"
          radius="md"
          onPress={() => void rules.refetch()}
        >
          {t("agent.approvals.retry")}
        </Button>
      </div>
    );
  } else if (!rules.isSuccess) {
    body = (
      <div className="h-10 rounded-lg bg-foreground/[0.04] shimmer-pulse" />
    );
  } else if (rows.length === 0) {
    body = (
      <p className="text-[12.5px] text-foreground/65">
        {t("agent.approvals.none")}
      </p>
    );
  } else {
    body = (
      <div className="-mx-2 divide-y divide-foreground/[0.05]">
        {rows.slice(0, FIRST_ROWS).map((row) => {
          const tool =
            row.targetKind === "capability"
              ? index.get(row.targetPattern)
              : undefined;
          return (
            <ApprovalLine
              key={row.id}
              row={row}
              title={titleOf(row)}
              where={whereOf(row)}
              readOnly={readOnly}
              onTakeBack={() => takeBack.ask(row)}
              doors={
                <>
                  {tool && (
                    <Button
                      as={Link}
                      href={capabilityPageHref(tool.id)}
                      data-approval-tool={tool.id}
                      size="sm"
                      variant="light"
                      radius="md"
                      className="min-h-9"
                    >
                      {t("agent.approvals.tool")}
                    </Button>
                  )}
                  <Button
                    as={Link}
                    href={`${allHref}&focus=${encodeURIComponent(row.id)}`}
                    data-approval-focus={row.id}
                    size="sm"
                    variant="light"
                    radius="md"
                    className="min-h-9"
                  >
                    {APPROVALS_TITLE}
                  </Button>
                </>
              }
            />
          );
        })}
      </div>
    );
  }

  return (
    <div data-agent-approvals="" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] font-medium text-foreground">
          {t("agent.approvals.rows")}
        </p>
        {!readOnly && rules.isSuccess && rows.length > 0 && (
          <Link
            href={allHref}
            className="text-[12.5px] font-medium text-primary underline-offset-2 hover:underline"
          >
            {rows.length > FIRST_ROWS
              ? `${t("agent.approvals.all")} (${rows.length})`
              : t("agent.approvals.all")}
          </Link>
        )}
      </div>
      {body}
      {takeBack.modal}
    </div>
  );
}

"use client";

/**
 * Agents & work's landing: the agents, one row each — who it is, how its
 * writes land (the choice in force as a mark, the pod's own sentence under
 * it), and two doors: "Change" opens the agent's page, where the ONE control
 * for it lives (`agentUsers.setPosture`), and "Why, per space" opens the grid
 * narrowed to that agent. Above them, the pod default those rows follow, with
 * its door to Settings. The full grid is the deep layer (`?view=grid`).
 */

import { Button } from "@heroui/react";
import { Bot } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { MatrixAgentRow } from "@synap-core/types/agent-matrix";
import { resolveServiceName } from "@synap-core/types/service-marks";
import { trpc } from "../../../../../lib/trpc";
import { navHref } from "../../../../../lib/console-nav";
import { openIn } from "../../../../../lib/open-in";
import { useT } from "../../../../../lib/i18n/locale-provider";
import { writesSummary } from "../../../../../lib/agent-writes/agent-writes";
import { en, fr } from "./copy";

const CATALOGS = { en, fr };

/** Rows drawn before "Show all" (lists are capped, rules/ui-composition). */
export const AGENT_LIST_CAP = 12;

/** The pod default every "follows the pod default" row means. EXPLAIN. */
export function PodDefaultLine() {
  const t = useT(CATALOGS);
  const read = trpc.governanceRules.reversibleDefault.useQuery(undefined, {
    staleTime: 30_000,
  });
  if (read.isLoading) {
    return (
      <div className="h-5 w-2/3 rounded bg-foreground/[0.06] shimmer-pulse" />
    );
  }
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-foreground/70">
      {read.isError || !read.data ? (
        <span className="text-status-down">
          {t("podDefault.failed")}{" "}
          <button
            type="button"
            className="font-medium text-primary underline-offset-2 hover:underline"
            onClick={() => void read.refetch()}
          >
            {t("retry")}
          </button>
        </span>
      ) : (
        <span>
          {read.data.enabled ? t("podDefault.on") : t("podDefault.off")}
        </span>
      )}
      <Link
        href={navHref("settings")}
        className="inline-flex min-h-6 items-center font-medium text-primary underline-offset-2 hover:underline"
      >
        {t("podDefault.change")}
      </Link>
    </p>
  );
}

export function AgentList({
  agents,
  whyHref,
}: {
  agents: ReadonlyArray<{ agent: MatrixAgentRow; computer: string | null }>;
  whyHref: (agentUserId: string) => string;
}) {
  const t = useT(CATALOGS);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? agents : agents.slice(0, AGENT_LIST_CAP);
  return (
    <div className="flex flex-col gap-2">
      <ul className="divide-y divide-foreground/[0.05] rounded-lg ring-1 ring-inset ring-foreground/10">
        {shown.map(({ agent, computer }) => (
          <AgentRow
            key={agent.agentUserId}
            agent={agent}
            computer={computer}
            whyHref={whyHref(agent.agentUserId)}
          />
        ))}
      </ul>
      {shown.length < agents.length && (
        <div>
          <Button
            size="sm"
            variant="flat"
            radius="md"
            onPress={() => setShowAll(true)}
          >
            {t("showAll", { count: agents.length })}
          </Button>
        </div>
      )}
    </div>
  );
}

function AgentRow({
  agent,
  computer,
  whyHref,
}: {
  agent: MatrixAgentRow;
  computer: string | null;
  whyHref: string;
}) {
  const t = useT(CATALOGS);
  const gov = trpc.agentUsers.governance.useQuery(
    { agentUserId: agent.agentUserId },
    { staleTime: 60_000, retry: false }
  );
  const agentHref = openIn({
    kind: "object",
    objectKind: "agent",
    id: agent.agentUserId,
  }).href;
  const who = [
    agent.agentType ? resolveServiceName(agent.agentType) : null,
    computer,
    agent.paused ? t("row.paused") : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const summary = gov.data ? writesSummary(gov.data) : null;

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-3">
      <Bot className="h-4 w-4 shrink-0 text-foreground/40" aria-hidden />
      <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
        <Link
          href={agentHref}
          className="truncate text-[13px] font-medium text-foreground hover:underline"
        >
          {agent.name}
        </Link>
        {who && (
          <span className="truncate text-[11.5px] text-foreground/65">
            {who}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-[2] basis-72 flex-col gap-0.5">
        {gov.isLoading ? (
          <div className="h-8 w-full rounded bg-foreground/[0.05] shimmer-pulse" />
        ) : gov.error?.data?.code === "NOT_FOUND" ? (
          <span className="text-[12px] text-foreground/65">
            {t("row.writesHidden")}
          </span>
        ) : gov.isError || !summary ? (
          <span className="text-[12px] text-status-down">
            {t("row.writesFailed")}{" "}
            <button
              type="button"
              className="font-medium text-primary underline-offset-2 hover:underline"
              onClick={() => void gov.refetch()}
            >
              {t("retry")}
            </button>
          </span>
        ) : (
          <>
            <span className="text-[12.5px] font-medium text-foreground">
              {summary.label}
            </span>
            <span className="text-[12px] text-foreground/65">
              {summary.line}
            </span>
            {summary.computer && (
              <span className="text-[12px] text-foreground/65">
                {t("row.computerDecides", { computer: summary.computer.name })}
              </span>
            )}
          </>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          as={Link}
          href={agentHref}
          size="sm"
          variant="flat"
          radius="md"
          className="min-h-10"
          aria-label={t("row.change.aria", { name: agent.name })}
        >
          {t("row.change")}
        </Button>
        <Button
          as={Link}
          href={whyHref}
          size="sm"
          variant="light"
          radius="md"
          className="min-h-10"
          aria-label={t("row.why.aria", { name: agent.name })}
        >
          {t("row.why")}
        </Button>
      </div>
    </li>
  );
}

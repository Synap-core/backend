"use client";

/**
 * Agents — every agent that can reach this pod, how it is doing, and who
 * answers for it.
 *
 * Roster: `agentUsers.list` (presence, keys, origin, reach, the viewer's
 * verbs) joined on `agentUserId` with `diagnose.agents` (lifetime approve /
 * refuse standing). Both reads are floored to the viewer (D1a): agents in
 * workspaces the viewer cannot see are not listed, and standings exist only
 * for agents the viewer owns (a pod admin opens any agent's scorecard from
 * its page). Each row is identity + one sentence + at most
 * one action; detail opens the agent's page.
 *
 * Pending keys and connect requests are NOT approved here — the row's one
 * action goes to Review, the one attention door. `?focus=<agentUserId>` (⌘K)
 * is received by the `data-row-id` wrappers.
 */

import { Button } from "@heroui/react";
import { ArrowRight, Bot } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useMemo } from "react";
import { openIn } from "../../../lib/open-in";
import { navHref } from "../../../lib/console-nav";
import { trpc } from "../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import { formatRelative } from "../../../lib/format";
import { PageFallback, PageHeader, PageShell } from "../components/page-header";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../components/resource-row";
import { SectionCard } from "../components/section-card";
import { useFocusRow } from "../components/use-focus-row";
import { filterBySearch } from "../components/list-search";
import { ListSearch, useDebouncedQuery } from "../components/list-search-box";
import { en as shellEn, fr as shellFr } from "../components/copy";
import { useAgentPeople } from "../../_lib/object/views/agent-object";
import {
  agentReviewHref,
  buildAgentRoster,
  standingLine,
  type AgentRowView,
} from "./_lib/agent-roster";
import { resolveObjectNounPlural } from "@synap-core/types/vocabulary";
import { useT } from "../../../lib/i18n/locale-provider";
import { en, fr } from "./_lib/copy";

const CATALOGS = { en, fr };
const SEARCH_CATALOGS = { en: shellEn, fr: shellFr };

/** Where every waiting access request is decided. */
const ACCESS_REVIEW_HREF = navHref("review", { type: "access" });

export default function AgentsPage() {
  return (
    <Suspense fallback={<PageFallback />}>
      <AgentsInner />
    </Suspense>
  );
}

function AgentsInner() {
  const t = useT(CATALOGS);
  const ts = useT(SEARCH_CATALOGS);
  const search = useDebouncedQuery();
  // Computers have their own page (Computers); their agents stay here.
  const list = trpc.agentUsers.list.useQuery(
    { includeComputers: false },
    { staleTime: 30_000 }
  );
  // Standings and owner names enrich rows; a failed read leaves them out
  // rather than failing the roster.
  const standings = trpc.diagnose.agents.useQuery(undefined, {
    staleTime: 60_000,
  });
  const { viewerId } = useAgentPeople();

  useEffect(() => {
    if (list.isError) redirectToLoginIfUnauthorized(list.error);
  }, [list.isError, list.error]);
  const isAuthRedirecting = list.error?.data?.code === "UNAUTHORIZED";

  useFocusRow({ ready: !list.isLoading });

  const roster = useMemo(
    () =>
      buildAgentRoster(list.data ?? [], standings.data ?? [], viewerId, (iso) =>
        formatRelative(iso)
      ),
    [list.data, standings.data, viewerId]
  );

  // A row opens the agent's page (`/open/agent/:id`): the same sections the
  // drawer drew, with the same acts, at an address that can be shared.
  const router = useRouter();
  const openAgent = (id: string) =>
    router.push(openIn({ kind: "object", objectKind: "agent", id }).href);

  const found = useMemo(
    () =>
      filterBySearch(roster, search.query, (v) => [
        v.row.name,
        v.row.email,
        v.sentence,
      ]),
    [roster, search.query]
  );
  const connected = found.filter((v) => v.direction === "external");
  const podOwn = found.filter((v) => v.direction === "house");
  const waiting = roster.filter((v) => v.needsReview).length;

  const isLoading = list.isLoading || isAuthRedirecting;

  return (
    <PageShell>
      <PageHeader
        title={resolveObjectNounPlural("agent")}
        description={t("description")}
      />

      <div className="flex flex-col gap-4">
        {roster.length > 0 && (
          <ListSearch
            value={search.input}
            onChange={search.setInput}
            label={ts("listSearch.agents")}
          />
        )}
        {waiting > 0 && (
          <Link
            href={ACCESS_REVIEW_HREF}
            className="flex min-h-10 items-center justify-between gap-3 rounded-lg bg-status-stale/10 px-3 py-2 text-[12.5px] text-foreground ring-1 ring-inset ring-status-stale/30 transition-colors hover:bg-status-stale/15"
          >
            <span>
              {waiting} {waiting === 1 ? "agent is" : "agents are"} waiting for
              your approval
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 font-medium">
              Review
              <ArrowRight className="h-3.5 w-3.5" />
            </span>
          </Link>
        )}

        <SectionCard
          title="Connected agents"
          hint="Agents people brought to this pod"
          actions={
            connected.length > 0 ? (
              <span className="text-[11px] tabular text-foreground/65">
                {connected.length}
              </span>
            ) : null
          }
        >
          {isLoading ? (
            <ResourceRowSkeleton count={3} />
          ) : list.isError ? (
            <ResourceRowError
              message="Couldn't load agents."
              onRetry={() => void list.refetch()}
            />
          ) : connected.length === 0 ? (
            <ResourceRowEmpty
              message={
                search.query ? (
                  ts("listSearch.none", { query: search.query })
                ) : (
                  <>
                    No agent has been connected yet. Run{" "}
                    <code className="font-mono">npx @synap-core/cli init</code>{" "}
                    on a computer to connect one.
                  </>
                )
              }
            />
          ) : (
            <AgentRows views={connected} onSelect={openAgent} />
          )}
        </SectionCard>

        {podOwn.length > 0 && (
          <SectionCard
            title="The pod's own agents"
            hint="The twin, capture agents and Intelligence personas"
          >
            <AgentRows views={podOwn} onSelect={openAgent} />
          </SectionCard>
        )}
      </div>
    </PageShell>
  );
}

function AgentRows({
  views,
  onSelect,
}: {
  views: AgentRowView[];
  onSelect: (id: string) => void;
}) {
  return (
    <div className="-mx-2 divide-y divide-foreground/[0.05]">
      {views.map((v) => {
        const standing = standingLine(v.standing);
        return (
          <div
            key={v.row.id}
            data-row-id={v.row.id}
            className="rounded-md transition-shadow"
          >
            <ResourceRow
              Icon={Bot}
              primary={v.row.name ?? v.row.email ?? "Unnamed agent"}
              secondary={standing ? `${v.sentence} ${standing}.` : v.sentence}
              status={v.status}
              onSelect={() => onSelect(v.row.id)}
              wrap
              actions={
                v.needsReview ? (
                  <Button
                    as={Link}
                    href={agentReviewHref(v.row)}
                    size="sm"
                    variant="flat"
                    radius="md"
                    className="min-h-9"
                  >
                    Review
                  </Button>
                ) : undefined
              }
            />
          </div>
        );
      })}
    </div>
  );
}

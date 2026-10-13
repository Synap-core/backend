"use client";

/**
 * Rules — what runs on its own, and whether it worked.
 *
 * Rows are `automations.listPage` (user-floored, D1a) followed to its end so
 * the filter counts are true over every rule, joined on `flowId` with the
 * `runs.groups` automation rows for health (latest run, failures this week).
 * Each row is identity + one line + one act (`rule-rows.ts` decides which);
 * the row opens `/rules/[id]`. Authoring stays in the desktop app.
 *
 * Receivers: `?filter=` (active · failing · never-ran · paused · drafts) and
 * `?focus=<automationId>` — Home's "rule never ran" links send both.
 */

import { addToast, Button } from "@heroui/react";
import { Zap } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { ruleWhenWords } from "@synap-core/types/automations";
import { navHref } from "../../../lib/console-nav";
import { trpc } from "../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import { formatRelative } from "../../../lib/format";
import { openIn } from "../../../lib/open-in";
import { ExitLink } from "../../../lib/exit-link";
import { ConfirmModal } from "../components/confirm-modal";
import { PageFallback, PageHeader, PageShell } from "../components/page-header";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../components/resource-row";
import { SectionCard } from "../components/section-card";
import { useFocusRow } from "../components/use-focus-row";
import { FilterChips } from "../components/filter-chips";
import {
  neverRanCallout,
  RULE_FILTERS,
  ruleCounts,
  ruleFilterOf,
  ruleMatches,
  rulePill,
  ruleRowAction,
  runResultMessage,
  runsPhrase,
  type RuleHealth,
} from "./_lib/rule-rows";
import { useDrainPages } from "../../../lib/use-drain-pages";

const TITLE = "Rules";
const DESCRIPTION = "What runs on its own, and whether it worked.";
/** 20 pages × 100 rows: past this the counts say they are partial. */
const MAX_PAGES = 20;
/** Rows drawn before "Show N more". */
const FIRST_ROWS = 25;

export default function RulesPage() {
  return (
    <Suspense fallback={<PageFallback />}>
      <RulesInner />
    </Suspense>
  );
}

type PendingAct = { kind: "pause" | "run"; id: string; name: string };

function RulesInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const filter = ruleFilterOf(searchParams.get("filter"));
  const utils = trpc.useUtils();

  const rules = trpc.automations.listPage.useInfiniteQuery(
    { limit: 100 },
    {
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      staleTime: 30_000,
    }
  );
  const groups = trpc.runs.groups.useInfiniteQuery(
    { flowType: "automation", limit: 100 },
    {
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      staleTime: 30_000,
    }
  );
  // Names for space ids; a failed read leaves the column saying "A space".
  const spaces = trpc.workspaces.adminListAll.useQuery(undefined, {
    staleTime: 60_000,
  });
  const ruleDrain = useDrainPages(rules, MAX_PAGES);
  const groupDrain = useDrainPages(groups, MAX_PAGES);

  useEffect(() => {
    if (rules.isError) redirectToLoginIfUnauthorized(rules.error);
  }, [rules.isError, rules.error]);
  const isAuthRedirecting = rules.error?.data?.code === "UNAUTHORIZED";

  const all = useMemo(
    () =>
      (rules.data?.pages ?? [])
        .flatMap((p) => p.automations)
        .filter((r) => r.status !== "archived"),
    [rules.data]
  );
  const healthById = useMemo(() => {
    const map = new Map<string, RuleHealth>();
    for (const g of (groups.data?.pages ?? []).flatMap((p) => p.groups)) {
      map.set(g.flowId, g);
    }
    return map;
  }, [groups.data]);
  const healthOf = (id: string) => healthById.get(id);
  const spaceName = useMemo(() => {
    const byId = new Map((spaces.data ?? []).map((s) => [s.id, s.name]));
    return (id: string | null) =>
      id ? (byId.get(id) ?? "A space") : "All spaces";
  }, [spaces.data]);

  // Counts and pills wait for health too: "Failing" read before the groups
  // land would undercount and then jump.
  const loading =
    rules.isLoading ||
    ruleDrain.draining ||
    groups.isLoading ||
    groupDrain.draining ||
    isAuthRedirecting;
  const counts = ruleCounts(all, healthOf);
  const visible = all.filter((r) => ruleMatches(filter, r, healthOf(r.id)));
  const focusId = useFocusRow({ ready: !loading });
  const [expanded, setExpanded] = useState(false);
  // A focused row past the fold must still be drawn for the highlight to land.
  const focusIndex = focusId ? visible.findIndex((r) => r.id === focusId) : -1;
  const shown =
    expanded || focusIndex >= FIRST_ROWS
      ? visible
      : visible.slice(0, FIRST_ROWS);
  const callout = filter === "never-ran" ? null : neverRanCallout(all);

  const [pending, setPending] = useState<PendingAct | null>(null);
  const [actError, setActError] = useState<string | null>(null);
  const refresh = async () => {
    await Promise.all([
      utils.automations.listPage.invalidate(),
      utils.runs.groups.invalidate(),
    ]);
  };
  const pause = trpc.automations.pause.useMutation();
  const trigger = trpc.automations.trigger.useMutation();

  async function confirmPending() {
    if (!pending) return;
    setActError(null);
    try {
      if (pending.kind === "pause") {
        await pause.mutateAsync({ id: pending.id });
        addToast({ title: `Paused “${pending.name}”`, color: "default" });
      } else {
        const result = await trigger.mutateAsync({ id: pending.id });
        addToast({
          title: runResultMessage(pending.name, result),
          color: "default",
        });
      }
      setPending(null);
      await refresh();
    } catch (err) {
      // The pod's refusal, as it said it — writes to a rule pass only for its
      // creator or a space admin, and guessing that client-side would hide a
      // button the owner may in fact be allowed to press.
      setActError(err instanceof Error ? err.message : "That didn’t work.");
    }
  }

  const appExit = openIn({ kind: "app", appId: "rules" });

  return (
    <PageShell>
      <PageHeader
        title={TITLE}
        description={DESCRIPTION}
        actions={<ExitLink exit={appExit} label="Create in app" />}
      />

      <FilterChips
        param="filter"
        defaultKey="active"
        active={filter}
        chips={RULE_FILTERS.map((f) => ({
          key: f.key,
          label: f.label,
          count: loading || rules.isError ? undefined : counts[f.key],
        }))}
      />

      {callout && !loading && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-foreground/[0.04] px-3 py-2.5 ring-1 ring-inset ring-foreground/10">
          <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-foreground/80">
            {callout}
          </p>
          <Button
            as={Link}
            href={navHref("rules", { filter: "never-ran" })}
            size="sm"
            variant="flat"
            radius="md"
          >
            Review never-ran rules
          </Button>
        </div>
      )}

      <SectionCard
        title={RULE_FILTERS.find((f) => f.key === filter)!.label}
        hint={
          loading || rules.isError
            ? undefined
            : `${counts.active} active · ${counts.failing} failing${
                ruleDrain.capped ? " · counts cover the first 2,000 rules" : ""
              }`
        }
      >
        {loading ? (
          <ResourceRowSkeleton count={4} />
        ) : rules.isError ? (
          <ResourceRowError
            message="Couldn't load rules."
            onRetry={() => void rules.refetch()}
          />
        ) : visible.length === 0 ? (
          <ResourceRowEmpty message={emptyMessage(filter, all.length)} />
        ) : (
          <div className="-mx-2 divide-y divide-foreground/[0.05]">
            {shown.map((rule) => {
              const health = healthOf(rule.id);
              const act = ruleRowAction(rule, health);
              const when = ruleWhenWords(
                rule.triggerType,
                rule.triggerConfig as Record<string, unknown> | null
              ).text;
              const secondary = [
                when,
                spaceName(rule.workspaceId),
                `Last run ${formatRelative(rule.lastRunAt, { empty: "never" })}`,
                runsPhrase(rule),
              ].join(" · ");
              return (
                <div
                  key={rule.id}
                  data-row-id={rule.id}
                  className="rounded-md transition-shadow"
                >
                  <ResourceRow
                    Icon={Zap}
                    primary={rule.name}
                    secondary={secondary}
                    status={rulePill(rule, health)}
                    onSelect={() =>
                      router.push(`/rules/${encodeURIComponent(rule.id)}`)
                    }
                    wrap
                    actions={
                      act ? (
                        <Button
                          size="sm"
                          variant="flat"
                          radius="md"
                          className="min-h-9"
                          color={act === "pause" ? "warning" : "default"}
                          onPress={() => {
                            setActError(null);
                            setPending({
                              kind: act,
                              id: rule.id,
                              name: rule.name,
                            });
                          }}
                        >
                          {act === "pause" ? "Pause" : "Run now"}
                        </Button>
                      ) : undefined
                    }
                  />
                </div>
              );
            })}
            {shown.length < visible.length && (
              <div className="px-3 pt-3">
                <Button
                  size="sm"
                  variant="light"
                  radius="md"
                  onPress={() => setExpanded(true)}
                >
                  Show {visible.length - shown.length} more
                </Button>
              </div>
            )}
          </div>
        )}
        {groups.isError && !loading && (
          <p className="px-1 pt-3 text-[12px] text-foreground/65">
            Run health couldn’t be loaded, so “Failing” may be missing rules.
          </p>
        )}
        {groupDrain.capped && (
          <p className="px-1 pt-3 text-[12px] text-foreground/65">
            Run health covers the 2,000 most recently run rules.
          </p>
        )}
      </SectionCard>

      <ConfirmModal
        isOpen={pending !== null}
        onClose={() => {
          setPending(null);
          setActError(null);
        }}
        onConfirm={() => void confirmPending()}
        title={
          pending?.kind === "run"
            ? `Run “${pending.name}” now?`
            : `Pause “${pending?.name ?? ""}”?`
        }
        consequence={
          pending?.kind === "run" ? (
            <>
              It runs its whole flow once, as if its trigger had happened —
              including anything it sends or changes. If the pod needs someone
              to approve it, it is proposed instead and waits in Review.
            </>
          ) : (
            <>
              It won’t start new runs until someone switches it back on (in the
              app). Nothing it already did is undone.
            </>
          )
        }
        confirmLabel={pending?.kind === "run" ? "Run now" : "Pause rule"}
        confirmColor="warning"
        isPending={pause.isPending || trigger.isPending}
      >
        {actError && (
          <p className="text-[12.5px] text-status-down">{actError}</p>
        )}
      </ConfirmModal>
    </PageShell>
  );
}

function emptyMessage(
  filter: ReturnType<typeof ruleFilterOf>,
  total: number
): string {
  if (total === 0) {
    return "No rules yet. Rules are made in the Synap app — “when this happens, do that”.";
  }
  switch (filter) {
    case "active":
      return "No rule is switched on.";
    case "failing":
      return "Nothing is failing. Every live rule’s runs this week went through.";
    case "never-ran":
      return "Every rule has run at least once.";
    case "paused":
      return "No paused rules.";
    case "drafts":
      return "No drafts.";
  }
}

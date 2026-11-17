"use client";

/**
 * Rules — what runs on its own, and whether it worked.
 *
 * Rows are `automations.listPage` (user-floored, D1a) followed to its end so
 * the filter counts are true over every rule, joined on `flowId` with the
 * `runs.groups` automation rows for health (latest run, failures this week),
 * AND the rules the pod applies itself (`skills.listReactionRules`, decision
 * D8: one list): its built-in rules and the roll-ups a relation declares. Those
 * read as rule rows (`reaction-rule-rows.ts`): the same filters and pill, their
 * recent outcomes as their runs, and one act, Pause or Turn on
 * (`skills.setReactionRule`, the governed rule door). Their row opens
 * `/rules/<rule id>`, which draws what it does and its history. The first page
 * draws at once; the counts say "…" until both reads are drained, and a pill
 * waits for its health rather than guessing. Each row is identity + one line +
 * one act (`rule-rows.ts` decides which), drawn by the shared
 * `ResponsiveTable`; the row opens `/rules/[id]`. Authoring stays in the
 * desktop app.
 *
 * Receivers: `?filter=` (active · failing · never-ran · paused · drafts) and
 * `?focus=<automationId>` — Home's "rule never ran" links send both.
 */

import { addToast, Button } from "@heroui/react";
import type { ReactNode } from "react";
import { Cog, Workflow, Zap } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { ruleWhenWords } from "@synap-core/types/automations";
import {
  resolveActionLabel,
  resolveObjectNoun,
} from "@synap-core/types/vocabulary";
import { navHref } from "../../../lib/console-nav";
import { trpc } from "../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import { formatRelative } from "../../../lib/format";
import { filterBySearch } from "../components/list-search";
import { ListSearch, useDebouncedQuery } from "../components/list-search-box";
import { useT } from "../../../lib/i18n/locale-provider";
import { en, fr } from "../components/copy";
import { openIn } from "../../../lib/open-in";
import { ExitLink } from "../../../lib/exit-link";
import { ConfirmModal } from "../components/confirm-modal";
import { StatusPill, type StatusKind } from "../components/status-pill";
import { PageFallback, PageHeader, PageShell } from "../components/page-header";
import {
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../components/resource-row";
import { ResponsiveTable } from "../components/responsive-table";
import { SectionCard } from "../components/section-card";
import { useFocusRow } from "../components/use-focus-row";
import { FilterChip, FilterRow } from "../components/filter-chip";
import { statusOption } from "../components/filter-options";
import {
  neverRanCallout,
  RULE_FILTERS,
  ruleCounts,
  ruleFilterOf,
  ruleMatches,
  rulePill,
  ruleInProcessScope,
  ruleRowAction,
  runResultMessage,
  runsPhrase,
  type RuleFacts,
  type RuleHealth,
  type RuleRowAction,
} from "./_lib/rule-rows";
import { useDrainPages } from "../../../lib/use-drain-pages";
import {
  reactionActivityPhrase,
  reactionPauseConsequence,
  reactionRuleAction,
  reactionRuleFacts,
  reactionRuleHealth,
  reactionRuleOrigin,
  ruleOriginLabel,
  type ReactionRuleWire,
} from "./_lib/reaction-rule-rows";

const CATALOGS = { en, fr };

/** `?process=` values: only the automations that belong to no process. */
type ProcessFilter = "outside";

const TITLE = "Automations";
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

type PendingAct = {
  kind: NonNullable<RuleRowAction>;
  id: string;
  name: string;
  /** A rule the pod applies (paused through the rule door, not an automation). */
  pod?: true;
};

function RulesInner() {
  const searchParams = useSearchParams();
  const filter = ruleFilterOf(searchParams.get("filter"));
  // `?process=outside`: only the automations that belong to no process
  // (Processes' door). Membership is the pod's (`playbooks.processes`
  // `automationsOutsideProcess`), never re-derived here.
  const processFilter: ProcessFilter | null =
    searchParams.get("process") === "outside" ? "outside" : null;
  const t = useT(CATALOGS);
  const search = useDebouncedQuery();
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
  // The rules the pod applies itself (built-in, declared on a relation).
  const podRules = trpc.skills.listReactionRules.useQuery(undefined, {
    staleTime: 30_000,
  });
  // Names for space ids; a failed read leaves the column saying "A space".
  const spaces = trpc.workspaces.adminListAll.useQuery(undefined, {
    staleTime: 60_000,
  });
  const index = trpc.playbooks.processes.useQuery(
    {},
    { staleTime: 30_000, enabled: processFilter !== null }
  );
  const outsideIds = useMemo(() => {
    const list = index.data?.automationsOutsideProcess;
    return list ? new Set(list.map((a) => a.id)) : null;
  }, [index.data]);
  // The filter is on and its read failed, or answered "could not read".
  const outsideFailed =
    processFilter !== null &&
    (index.isError || (index.isSuccess && outsideIds === null));
  const ruleDrain = useDrainPages(rules, MAX_PAGES);
  const groupDrain = useDrainPages(groups, MAX_PAGES);

  useEffect(() => {
    if (rules.isError) redirectToLoginIfUnauthorized(rules.error);
  }, [rules.isError, rules.error]);
  const isAuthRedirecting = rules.error?.data?.code === "UNAUTHORIZED";

  const podById = useMemo(
    () =>
      new Map(
        ((podRules.data ?? []) as unknown as ReactionRuleWire[]).map((r) => [
          r.id,
          r,
        ])
      ),
    [podRules.data]
  );
  const all = useMemo(
    // The person's own automations in the list's own order, then the pod's
    // (built in, declared on a link): one order, each row marked with where
    // it comes from, never a block pinned above theirs.
    (): RuleRow[] => [
      ...(rules.data?.pages ?? [])
        .flatMap((p) => p.automations)
        .filter((r) => r.status !== "archived"),
      ...[...podById.values()].map((r) => ({
        ...reactionRuleFacts(r),
        triggerConfig: null,
      })),
    ],
    [rules.data, podById]
  );
  const healthById = useMemo(() => {
    const map = new Map<string, RuleHealth>();
    for (const g of (groups.data?.pages ?? []).flatMap((p) => p.groups)) {
      map.set(g.flowId, g);
    }
    for (const r of podById.values()) map.set(r.id, reactionRuleHealth(r));
    return map;
  }, [groups.data, podById]);
  const healthOf = (id: string) => healthById.get(id);
  const spaceName = useMemo(() => {
    const byId = new Map((spaces.data ?? []).map((s) => [s.id, s.name]));
    return (id: string | null) =>
      id ? (byId.get(id) ?? "A space") : "All spaces";
  }, [spaces.data]);

  // The pod's automations load beside the person's: the list draws once, in
  // its final order, never with rows popping in under a Pause button.
  const loading = rules.isLoading || podRules.isLoading || isAuthRedirecting;
  // Counts and pills wait for health too: "Failing" read before the groups
  // land would undercount and then jump.
  const healthReady = !groups.isLoading && !groupDrain.draining;
  const counting = ruleDrain.draining || !healthReady;
  // The Process filter narrows first, so the Show chip's counts are over the
  // same set the list draws (Processes' footer counts the active ones).
  const scoped = all.filter((r) =>
    ruleInProcessScope(r.id, processFilter, outsideIds)
  );
  const counts = ruleCounts(scoped, healthOf);
  const visible = filterBySearch(
    scoped.filter((r) => ruleMatches(filter, r, healthOf(r.id))),
    search.query,
    (r) => [r.name, spaceName(r.workspaceId)]
  );
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
      utils.automations.invalidate(),
      utils.runs.groups.invalidate(),
      utils.skills.listReactionRules.invalidate(),
    ]);
  };
  const pause = trpc.automations.pause.useMutation();
  const setPodRule = trpc.skills.setReactionRule.useMutation();
  const trigger = trpc.automations.trigger.useMutation();
  const activate = trpc.automations.activate.useMutation();

  async function confirmPending() {
    if (!pending) return;
    setActError(null);
    try {
      if (pending.pod) {
        const on = pending.kind === "turn_on";
        const result = await setPodRule.mutateAsync({ id: pending.id, on });
        addToast({
          title:
            result.status === "proposed"
              ? `Sent “${pending.name}” for review`
              : on
                ? `${resolveActionLabel("turn_on", "past")} “${pending.name}”`
                : `Paused “${pending.name}”`,
          color: "default",
        });
      } else if (pending.kind === "pause") {
        await pause.mutateAsync({ id: pending.id });
        addToast({ title: `Paused “${pending.name}”`, color: "default" });
      } else if (pending.kind === "turn_on") {
        const result = await activate.mutateAsync({ id: pending.id });
        addToast({
          // An agent's key proposes instead of switching it on: said so.
          title:
            result.status === "proposed"
              ? `Sent “${pending.name}” for review`
              : `${resolveActionLabel("turn_on", "past")} “${pending.name}”`,
          color: "default",
        });
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

  /** One rule's cells, shared by the table and the stacked row. */
  function rowOf(rule: RuleRow): RuleRowView {
    const health = healthOf(rule.id);
    const pod = podById.get(rule.id);
    const act = pod ? reactionRuleAction(pod) : ruleRowAction(rule, health);
    return {
      when: pod
        ? pod.when
        : ruleWhenWords(
            rule.triggerType,
            rule.triggerConfig as Record<string, unknown> | null
          ).text,
      runs: pod ? reactionActivityPhrase(pod) : null,
      origin: ruleOriginLabel(pod ? reactionRuleOrigin(pod) : "yours"),
      space: spaceName(rule.workspaceId),
      lastRun: formatRelative(rule.lastRunAt, { empty: "never" }),
      pill: healthReady ? rulePill(rule, health) : undefined,
      action: act ? (
        <RuleActButton
          act={act}
          onPress={() => {
            setActError(null);
            setPending({
              kind: act,
              id: rule.id,
              name: rule.name,
              ...(pod ? { pod: true as const } : {}),
            });
          }}
        />
      ) : undefined,
    };
  }

  const views = new Map(shown.map((rule) => [rule.id, rowOf(rule)]));
  const view = (rule: RuleRow) => views.get(rule.id)!;

  return (
    <PageShell>
      <PageHeader
        title={TITLE}
        description={DESCRIPTION}
        actions={<ExitLink exit={appExit} label="Create in app" />}
      />

      <FilterRow
        filters={
          <>
            <FilterChip
              label="Show"
              allLabel={null}
              param="filter"
              defaultValue="active"
              value={filter}
              options={RULE_FILTERS.map((f) =>
                statusOption(f.key, {
                  label: f.label,
                  count:
                    loading ||
                    rules.isError ||
                    outsideFailed ||
                    (processFilter !== null && index.isLoading)
                      ? null
                      : counting
                        ? "…"
                        : counts[f.key],
                })
              )}
            />
            <FilterChip<ProcessFilter>
              label={resolveObjectNoun("playbook")}
              allLabel={t("rules.anyProcess")}
              param="process"
              value={processFilter}
              options={[
                {
                  id: "outside",
                  label: t("rules.outside"),
                  icon: Workflow,
                },
              ]}
            />
          </>
        }
        search={
          <ListSearch
            value={search.input}
            onChange={search.setInput}
            label={t("listSearch.rules")}
            className=""
          />
        }
      />

      {callout && !loading && !ruleDrain.draining && (
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
            Review never-ran automations
          </Button>
        </div>
      )}

      <SectionCard
        title={RULE_FILTERS.find((f) => f.key === filter)!.label}
        hint={
          loading || rules.isError
            ? undefined
            : counting
              ? "Counting…"
              : `${counts.active} active · ${counts.failing} failing${
                  ruleDrain.capped
                    ? " · counts cover the first 2,000 automations"
                    : ""
                }`
        }
      >
        {loading ||
        (visible.length === 0 && counting) ||
        (processFilter !== null && index.isLoading) ? (
          <ResourceRowSkeleton count={4} />
        ) : rules.isError ? (
          <ResourceRowError
            message="Couldn't load automations."
            onRetry={() => void rules.refetch()}
          />
        ) : outsideFailed ? (
          <ResourceRowError
            message={t("rules.outsideFailed")}
            onRetry={() => void index.refetch()}
          />
        ) : visible.length === 0 ? (
          <>
            <ResourceRowEmpty
              message={
                search.query
                  ? t("listSearch.none", { query: search.query })
                  : emptyMessage(filter, all.length)
              }
            />
          </>
        ) : (
          <>
            {search.query && (ruleDrain.draining || ruleDrain.capped) && (
              <p className="mb-2 text-[12px] text-foreground/65">
                {t("listSearch.partial.rules", { n: all.length })}
              </p>
            )}
            <ResponsiveTable
              ariaLabel="Automations"
              rows={shown}
              rowKey={(rule) => rule.id}
              rowId={(rule) => rule.id}
              href={ruleHref}
              name={{
                header: "Name",
                width: "minmax(0,2fr)",
                label: (rule) => rule.name,
                sub: (rule) => (
                  <span className="text-[12px] text-foreground/65">
                    {view(rule).origin}
                  </span>
                ),
              }}
              columns={[
                {
                  header: "Trigger",
                  width: "minmax(0,2fr)",
                  cell: (rule) => view(rule).when,
                },
                {
                  header: "Space",
                  width: "minmax(0,1fr)",
                  cell: (rule) => view(rule).space,
                },
                {
                  header: "Last run",
                  width: "minmax(0,0.9fr)",
                  cell: (rule) => view(rule).lastRun,
                },
                {
                  header: "Runs / fails",
                  width: "minmax(0,0.9fr)",
                  cell: (rule) =>
                    view(rule).runs ?? (
                      <span className="tabular">
                        {rule.runCount.toLocaleString("en-US")} /{" "}
                        {rule.failureCount.toLocaleString("en-US")}
                      </span>
                    ),
                },
                {
                  header: "Status",
                  width: "minmax(0,1.2fr)",
                  className: "min-w-0",
                  cell: (rule) => <RulePill pill={view(rule).pill} />,
                },
              ]}
              action={{
                width: "6.5rem",
                cell: (rule) => view(rule).action,
              }}
              phone={(rule) => {
                const row = view(rule);
                return {
                  Icon: podById.has(rule.id) ? Cog : Zap,
                  secondary: [
                    row.origin,
                    row.when,
                    row.space,
                    `Last run ${row.lastRun}`,
                    row.runs ?? runsPhrase(rule),
                  ].join(" · "),
                  status: row.pill,
                };
              }}
            />
            {shown.length < visible.length && (
              <div className="px-1 pt-3">
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
          </>
        )}
        {podRules.isError && !loading && (
          <div className="flex flex-wrap items-center gap-2 px-1 pt-3">
            <p className="text-[12px] text-foreground/65">
              The pod’s own automations couldn’t be loaded, so they are missing
              from this list.
            </p>
            <Button
              size="sm"
              variant="light"
              radius="md"
              onPress={() => void podRules.refetch()}
            >
              Try again
            </Button>
          </div>
        )}
        {groups.isError && !loading && (
          <p className="px-1 pt-3 text-[12px] text-foreground/65">
            Run health couldn’t be loaded, so “Failing” may be missing
            automations.
          </p>
        )}
        {groupDrain.capped && (
          <p className="px-1 pt-3 text-[12px] text-foreground/65">
            Run health covers the 2,000 most recently run automations.
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
            : pending?.kind === "turn_on"
              ? `${resolveActionLabel("turn_on")} “${pending.name}”?`
              : `Pause “${pending?.name ?? ""}”?`
        }
        consequence={
          pending?.kind === "run" ? (
            <>
              It runs its whole flow once, as if its trigger had happened —
              including anything it sends or changes. If the pod needs someone
              to approve it, it is proposed instead and waits in Review.
            </>
          ) : pending?.pod && pending.kind === "turn_on" ? (
            <>
              From now on the pod applies it, for everyone in this pod, each
              time its trigger happens. You can pause it here at any time.
            </>
          ) : pending?.pod && podById.get(pending.id) ? (
            <>{reactionPauseConsequence(podById.get(pending.id)!)}</>
          ) : pending?.kind === "turn_on" ? (
            <>
              From now on it runs on its own each time its trigger happens,
              including anything it sends or changes. You can pause it here at
              any time.
            </>
          ) : (
            <>
              It won’t start new runs until someone turns it back on. Nothing it
              already did is undone.
            </>
          )
        }
        confirmLabel={
          pending?.kind === "run"
            ? "Run now"
            : pending?.kind === "turn_on"
              ? resolveActionLabel("turn_on")
              : "Pause automation"
        }
        confirmColor="warning"
        isPending={
          pause.isPending ||
          trigger.isPending ||
          activate.isPending ||
          setPodRule.isPending
        }
      >
        {actError && (
          <p className="text-[12.5px] text-status-down">{actError}</p>
        )}
      </ConfirmModal>
    </PageShell>
  );
}

type RuleRow = RuleFacts & {
  workspaceId: string | null;
  triggerConfig: unknown;
};

interface RuleRowView {
  when: string;
  /** Where it comes from: Built in, Declared on a link, Yours. */
  origin: string;
  /** A pod rule's "2 applied lately", in place of runs / fails. */
  runs: string | null;
  space: string;
  lastRun: string;
  /** Absent until the rule's run health is read. */
  pill: { kind: StatusKind; label: string } | undefined;
  action: ReactNode;
}

function RuleActButton({
  act,
  onPress,
}: {
  act: NonNullable<RuleRowAction>;
  onPress: () => void;
}) {
  return (
    <Button
      size="sm"
      variant="flat"
      radius="md"
      className="min-h-9"
      onPress={onPress}
    >
      {act === "pause"
        ? "Pause"
        : act === "turn_on"
          ? resolveActionLabel("turn_on")
          : "Run now"}
    </Button>
  );
}

/** A rule's pill, or a placeholder while its run health is read. */
function RulePill({ pill }: { pill: RuleRowView["pill"] }) {
  return pill ? (
    <StatusPill kind={pill.kind} label={pill.label} />
  ) : (
    <span
      aria-label="Reading run health"
      className="inline-block h-4 w-16 rounded bg-foreground/[0.07] shimmer-pulse"
    />
  );
}

const ruleHref = (rule: { id: string }) =>
  `/rules/${encodeURIComponent(rule.id)}`;

function emptyMessage(
  filter: ReturnType<typeof ruleFilterOf>,
  total: number
): string {
  if (total === 0) {
    return "No automations yet. Automations are made in the Synap app: “when this happens, do that”.";
  }
  switch (filter) {
    case "active":
      return "No automation is switched on.";
    case "failing":
      return "Nothing is failing. Every live automation’s runs this week went through.";
    case "never-ran":
      return "Every automation has run at least once.";
    case "paused":
      return "No paused rules.";
    case "drafts":
      return "No drafts.";
  }
}

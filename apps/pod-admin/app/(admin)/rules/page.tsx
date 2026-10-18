"use client";

/**
 * Rules — what runs on its own, and whether it worked.
 *
 * Rows are `automations.listPage` (user-floored, D1a) followed to its end so
 * the filter counts are true over every rule, joined on `flowId` with the
 * `runs.groups` automation rows for health (latest run, failures this week).
 * The first page draws at once; the counts say "…" until both reads are
 * drained, and a pill waits for its health rather than guessing. Each row is
 * identity + one line + one act (`rule-rows.ts` decides which), drawn by the
 * shared `ResponsiveTable`; the row opens `/rules/[id]`.
 * Authoring stays in the desktop app.
 *
 * Receivers: `?filter=` (active · failing · never-ran · paused · drafts) and
 * `?focus=<automationId>` — Home's "rule never ran" links send both.
 */

import { addToast, Button } from "@heroui/react";
import type { ReactNode } from "react";
import { Zap } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { ruleWhenWords } from "@synap-core/types/automations";
import { navHref } from "../../../lib/console-nav";
import { trpc } from "../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import { formatRelative } from "../../../lib/format";
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
  type RuleFacts,
  type RuleHealth,
  type RuleRowAction,
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

  const loading = rules.isLoading || isAuthRedirecting;
  // Counts and pills wait for health too: "Failing" read before the groups
  // land would undercount and then jump.
  const healthReady = !groups.isLoading && !groupDrain.draining;
  const counting = ruleDrain.draining || !healthReady;
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
      utils.automations.invalidate(),
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

  /** One rule's cells, shared by the table and the stacked row. */
  function rowOf(rule: RuleRow): RuleRowView {
    const health = healthOf(rule.id);
    const act = ruleRowAction(rule, health);
    return {
      when: ruleWhenWords(
        rule.triggerType,
        rule.triggerConfig as Record<string, unknown> | null
      ).text,
      space: spaceName(rule.workspaceId),
      lastRun: formatRelative(rule.lastRunAt, { empty: "never" }),
      pill: healthReady ? rulePill(rule, health) : undefined,
      action: act ? (
        <RuleActButton
          act={act}
          onPress={() => {
            setActError(null);
            setPending({ kind: act, id: rule.id, name: rule.name });
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

      <FilterChips
        param="filter"
        defaultKey="active"
        active={filter}
        chips={RULE_FILTERS.map((f) => ({
          key: f.key,
          label: f.label,
          count:
            loading || rules.isError
              ? undefined
              : counting
                ? "…"
                : counts[f.key],
        }))}
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
            Review never-ran rules
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
                    ? " · counts cover the first 2,000 rules"
                    : ""
                }`
        }
      >
        {loading || (visible.length === 0 && counting) ? (
          <ResourceRowSkeleton count={4} />
        ) : rules.isError ? (
          <ResourceRowError
            message="Couldn't load rules."
            onRetry={() => void rules.refetch()}
          />
        ) : visible.length === 0 ? (
          <ResourceRowEmpty message={emptyMessage(filter, all.length)} />
        ) : (
          <>
            <ResponsiveTable
              ariaLabel="Rules"
              rows={shown}
              rowKey={(rule) => rule.id}
              rowId={(rule) => rule.id}
              href={ruleHref}
              name={{
                header: "Name",
                width: "minmax(0,2fr)",
                label: (rule) => rule.name,
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
                  cell: (rule) => (
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
                  Icon: Zap,
                  secondary: [
                    row.when,
                    row.space,
                    `Last run ${row.lastRun}`,
                    runsPhrase(rule),
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

type RuleRow = RuleFacts & {
  workspaceId: string | null;
  triggerConfig: unknown;
};

interface RuleRowView {
  when: string;
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
      {act === "pause" ? "Pause" : "Run now"}
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

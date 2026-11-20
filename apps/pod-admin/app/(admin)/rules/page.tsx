"use client";

/**
 * Rules — the guidelines (always / never) pushed into every piece of work in
 * their scope; the agent cannot skip one (founder, 19 Nov 2026, document
 * b387ca45 §9). A skill is know-how pulled when needed and stays under Tools;
 * what runs by itself is an Automation (`/automations`, where this route's
 * old page now lives); who may act without asking is Approvals.
 *
 * Rows: every skill the reader can see (`useAllSkills`, the read Tools uses)
 * that `isRuleSkill` calls a rule, with where it is pushed. A rule that came
 * with an automation (the rule loop, `skills.listRules`' `activates` edge)
 * links to it as its own object. Each row opens the rule's own page
 * (`/open/skill/<id>`, which names it a Rule). Receivers: `?where=` and
 * `?focus=<skill id>`.
 */

import { Button } from "@heroui/react";
import { ListChecks } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo } from "react";
import { resolveObjectNounPlural } from "@synap-core/types/vocabulary";
import { trpc } from "../../../lib/trpc";
import { navHref } from "../../../lib/console-nav";
import { openIn } from "../../../lib/open-in";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import { useT } from "../../../lib/i18n/locale-provider";
import {
  FilterChip,
  ListCard,
  ListToolbar,
  PageHeader,
} from "../components/list-page";
import { PageFallback, PageShell } from "../components/page-header";
import { ListSearch, useDebouncedQuery } from "../components/list-search-box";
import { ResourceRow } from "../components/resource-row";
import { useFocusRow } from "../components/use-focus-row";
import { approvedStatus } from "../tools/_lib/tool-status";
import { useAllSkills } from "../tools/_lib/use-all-skills";
import { en, fr } from "./_lib/copy";
import {
  automationsByRule,
  ruleMatchesSearch,
  ruleScopeKey,
  rulesOf,
  type RuleRow,
  type RuleSourceLike,
} from "./_lib/rules-model";

const CATALOGS = { en, fr };
const TITLE = resolveObjectNounPlural("rule");

export default function RulesPage() {
  return (
    <Suspense fallback={<PageFallback />}>
      <RulesInner />
    </Suspense>
  );
}

function RulesInner() {
  const t = useT(CATALOGS);
  const router = useRouter();
  const params = useSearchParams();
  const where = params.get("where");
  const search = useDebouncedQuery();

  const skills = useAllSkills();
  // Which rules came with an automation: the `activates` edge, read by the pod.
  const lineage = trpc.skills.listRules.useQuery(
    { limit: 100 },
    { staleTime: 30_000, retry: false }
  );
  const spaces = trpc.workspaces.list.useQuery(undefined, {
    staleTime: 60_000,
    retry: false,
  });

  useEffect(() => {
    if (skills.error) redirectToLoginIfUnauthorized(skills.error);
  }, [skills.error]);

  const rows = useMemo(
    () => rulesOf((skills.skills ?? []) as readonly RuleSourceLike[]),
    [skills.skills]
  );
  const automations = useMemo(
    () => automationsByRule(lineage.data?.rules ?? []),
    [lineage.data]
  );
  const spaceName = useMemo(() => {
    const byId = new Map((spaces.data ?? []).map((s) => [s.id, s.name]));
    return (id: string) => byId.get(id);
  }, [spaces.data]);
  const whereLabel = (key: string) =>
    key === "pod"
      ? t("where.pod")
      : key === "user"
        ? t("where.user")
        : (spaceName(key) ?? t("where.space"));

  // The chip's values are the scopes the rules are in, never a fixed list.
  const whereCounts = new Map<string, number>();
  for (const r of rows) {
    const key = ruleScopeKey(r);
    whereCounts.set(key, (whereCounts.get(key) ?? 0) + 1);
  }
  const whereOptions = [...whereCounts].map(([id, count]) => ({
    id,
    label: whereLabel(id),
    count,
  }));

  const shown = rows.filter(
    (r) =>
      (!where || ruleScopeKey(r) === where) &&
      ruleMatchesSearch(r, search.query)
  );
  useFocusRow({ ready: !skills.isLoading });

  return (
    <PageShell>
      <PageHeader title={TITLE} description={t("description")} />

      <ListToolbar
        search={
          <ListSearch
            value={search.input}
            onChange={search.setInput}
            label={t("search")}
            className=""
          />
        }
        filters={
          <FilterChip
            label={t("filter.where")}
            allLabel={t("filter.anywhere")}
            param="where"
            value={where}
            options={whereOptions}
          />
        }
      />

      <ListCard
        title={t("list.title")}
        count={skills.isLoading || skills.isError ? null : shown.length}
        loading={skills.isLoading}
        isError={skills.isError}
        onRetry={skills.refetch}
        errorMessage={t("list.failed")}
        rowCount={shown.length}
        emptyMessage={
          rows.length === 0
            ? t("list.empty")
            : search.query
              ? t("list.none", { query: search.query })
              : t("list.noneHere")
        }
        skeletonRows={4}
        footer={
          <>
            {skills.capped && (
              <p className="px-1 pt-3 text-[12px] text-foreground/65">
                {t("list.partial", { count: skills.shown })}
              </p>
            )}
            {lineage.isError && !skills.isLoading && (
              <div className="flex flex-wrap items-center gap-2 px-1 pt-3">
                <p className="text-[12px] text-foreground/65">
                  {t("automation.failed")}
                </p>
                <Button
                  size="sm"
                  variant="light"
                  radius="md"
                  onPress={() => void lineage.refetch()}
                >
                  {t("retry")}
                </Button>
              </div>
            )}
          </>
        }
      >
        <div className="-mx-2 divide-y divide-foreground/[0.05]">
          {shown.map((rule) => (
            <RuleLine
              key={rule.id}
              rule={rule}
              where={whereLabel(ruleScopeKey(rule))}
              automationIds={automations.get(rule.id) ?? []}
              onOpen={() =>
                router.push(
                  openIn({ kind: "object", objectKind: "skill", id: rule.id })
                    .href
                )
              }
            />
          ))}
        </div>
      </ListCard>
    </PageShell>
  );
}

function RuleLine({
  rule,
  where,
  automationIds,
  onOpen,
}: {
  rule: RuleRow;
  where: string;
  automationIds: readonly string[];
  onOpen: () => void;
}) {
  const t = useT(CATALOGS);
  const first = automationIds[0];
  return (
    <div data-row-id={rule.id} className="rounded-md transition-shadow">
      <ResourceRow
        Icon={ListChecks}
        primary={rule.name}
        secondary={[where, rule.slug].filter(Boolean).join(" · ")}
        status={approvedStatus(rule)}
        onSelect={onOpen}
        wrap
        actions={
          first ? (
            // The automation it came with: its own object, its own page.
            <Button
              as={Link}
              href={
                automationIds.length === 1
                  ? `${navHref("automations")}/${encodeURIComponent(first)}`
                  : navHref("automations", { focus: first })
              }
              size="sm"
              variant="light"
              radius="md"
              className="min-h-9"
            >
              {automationIds.length === 1
                ? t("automation.one")
                : t("automation.many", { count: automationIds.length })}
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}

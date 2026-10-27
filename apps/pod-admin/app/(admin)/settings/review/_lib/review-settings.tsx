"use client";

/**
 * Settings › Review (founder B-3, B-4, 27 Oct 2026) — the same choices the
 * Review page and the onboarding step make, in one place:
 *
 *   Group by           Package (default) · Work · Agent · Time
 *   Layout per package for each package that has a second layout
 *   Hand-offs          the agents the person always lets take hand-offs:
 *                      one `governance_rules` row each, created and revoked
 *                      through `governanceRules`' own doors (`create` is the
 *                      human credential door — an agent can never set it).
 *
 * The first two read and write `uiPreferences.review` through
 * `useReviewPreferences` — the one door all three surfaces share.
 */

import { useEffect, useState } from "react";
import { Switch, addToast } from "@heroui/react";
import {
  REVIEW_GROUP_BYS,
  REVIEW_PACKAGES,
  REVIEW_PACKAGE_LAYOUTS,
} from "@synap-core/types/proposals/review-package";
import {
  resolveObjectNoun,
  resolveReviewGroupByLabel,
  resolveReviewLayoutLabel,
  resolveReviewPackageLabel,
} from "@synap-core/types/vocabulary";
import { trpc } from "../../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../../lib/auth-redirect";
import { PageHeader, PageShell } from "../../../components/page-header";
import { SectionCard } from "../../../components/section-card";
import { FilterChips } from "../../../components/filter-chips";
import {
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../../components/resource-row";
import { useReviewPreferences } from "../../../review/_lib/review-preferences";
import {
  handOffRuleFor,
  isHandOffRule,
} from "../../../review/_lib/hand-off-rule";

/** What each grouping does — one line under the control. Product copy. */
const GROUP_BY_HINT = {
  package:
    "By the decision each item asks: questions first, then access, releases, rules, changes, hand-offs, knowledge and bookkeeping.",
  work: "Each piece of work shows its questions and its changes together.",
  agent: "Each agent shows what it asks for.",
  time: "One list, newest first.",
} as const;

export function ReviewSettings() {
  const prefs = useReviewPreferences();
  return (
    <PageShell>
      <PageHeader
        title="Review settings"
        description="How what your agents ask you is laid out on Review. Saved to your account."
      />
      <div className="flex flex-col gap-4">
        <SectionCard title="Group by" hint={GROUP_BY_HINT[prefs.groupBy]}>
          {prefs.isLoading ? (
            <ResourceRowSkeleton count={1} />
          ) : prefs.isError ? (
            <p className="text-[12.5px] text-status-down">
              Your saved choice could not be read; Review opens by package until
              it can.
            </p>
          ) : (
            <FilterChips
              ariaLabel="Group by"
              className=""
              active={prefs.groupBy}
              chips={REVIEW_GROUP_BYS.map((g) => ({
                key: g,
                label: resolveReviewGroupByLabel(g),
              }))}
              onSelect={prefs.setGroupBy}
            />
          )}
        </SectionCard>

        <SectionCard
          title="Layout of each package"
          hint="Each kind of decision opens in its own shape. Switch any of them to a plain list."
        >
          <ul className="-mx-2 divide-y divide-foreground/[0.05]">
            {REVIEW_PACKAGES.filter(
              (pkg) => REVIEW_PACKAGE_LAYOUTS[pkg].length > 1
            ).map((pkg) => (
              <li
                key={pkg}
                className="flex min-h-12 flex-wrap items-center gap-3 px-3 py-2"
              >
                <span className="min-w-0 flex-1 text-[13px] font-medium text-foreground">
                  {resolveReviewPackageLabel(pkg)}
                </span>
                <FilterChips
                  ariaLabel={`${resolveReviewPackageLabel(pkg)} layout`}
                  className=""
                  active={prefs.layoutOf(pkg)}
                  chips={REVIEW_PACKAGE_LAYOUTS[pkg].map((l) => ({
                    key: l,
                    label: resolveReviewLayoutLabel(l),
                  }))}
                  onSelect={(l) => prefs.setLayout(pkg, l)}
                />
              </li>
            ))}
          </ul>
        </SectionCard>

        <HandOffRules />
      </div>
    </PageShell>
  );
}

/** The agents the person always lets take hand-offs (B-3). */
function HandOffRules() {
  const utils = trpc.useUtils();
  const agents = trpc.agentUsers.list.useQuery(
    { includeComputers: false },
    { staleTime: 30_000 }
  );
  const rules = trpc.governanceRules.list.useQuery({});
  useEffect(() => {
    const err = agents.error ?? rules.error;
    if (err) redirectToLoginIfUnauthorized(err);
  }, [agents.error, rules.error]);

  const create = trpc.governanceRules.create.useMutation();
  const revoke = trpc.governanceRules.revoke.useMutation();
  const [pending, setPending] = useState<string | null>(null);

  const ruleByAgent = new Map(
    (rules.data?.rules ?? [])
      .filter(isHandOffRule)
      .map((r) => [r.agentUserId as string, r])
  );

  async function toggle(agentId: string, name: string, on: boolean) {
    setPending(agentId);
    try {
      const rule = ruleByAgent.get(agentId);
      if (on && !rule) {
        await create.mutateAsync(
          // The helper's draft IS the door's input.
          handOffRuleFor(agentId) as Parameters<typeof create.mutateAsync>[0]
        );
      } else if (!on && rule) {
        await revoke.mutateAsync({ id: rule.id });
      }
      await utils.governanceRules.list.invalidate();
      addToast({
        title: on
          ? `${name} may take hand-offs without asking`
          : `${name} asks again before taking hand-offs`,
        color: "success",
      });
    } catch (err) {
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        title: "Not changed",
        description: err instanceof Error ? err.message : undefined,
        color: "danger",
      });
    } finally {
      setPending(null);
    }
  }

  const rows = agents.data ?? [];
  return (
    <SectionCard
      title="Hand-offs you always allow"
      hint="An agent here may hand a session to an agent without asking you. It never covers deletes or access."
    >
      {agents.isLoading || rules.isLoading ? (
        <ResourceRowSkeleton count={2} />
      ) : agents.isError || rules.isError ? (
        <ResourceRowError
          message="Couldn't load your agents and their rules."
          onRetry={() => {
            void agents.refetch();
            void rules.refetch();
          }}
        />
      ) : rows.length === 0 ? (
        <ResourceRowEmpty message="No agent works for you yet." />
      ) : (
        <ul className="-mx-2 divide-y divide-foreground/[0.05]">
          {rows.map((a: { id: string; name?: string | null }) => {
            const name = a.name || resolveObjectNoun("agent");
            const on = ruleByAgent.has(a.id);
            return (
              <li
                key={a.id}
                className="flex min-h-12 items-center gap-3 px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                  {name}
                </span>
                <span className="text-[12px] text-foreground/65">
                  {on ? "Always allowed" : "Asks you"}
                </span>
                <Switch
                  size="sm"
                  isSelected={on}
                  isDisabled={pending === a.id}
                  onValueChange={(next) => void toggle(a.id, name, next)}
                  aria-label={`${name}: always allow hand-offs`}
                />
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

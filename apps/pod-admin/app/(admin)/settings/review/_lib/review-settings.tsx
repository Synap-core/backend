"use client";

/**
 * Réglages (the client scope's Settings, PA-G-06) — the person's language,
 * then (founder B-3, B-4, 27 Oct 2026) the same choices the Review page and
 * its layout offer make, in one place:
 *
 *   Language           English · Français: `users.setLocale`, the language
 *                      every surface reads from `users.me.locale`
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
import { SUPPORTED_LOCALES } from "@synap-core/types/i18n";
import { TRPCClientError } from "@trpc/client";
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
import {
  useConsoleLocale,
  useT,
} from "../../../../../lib/i18n/locale-provider";
import { en, fr } from "./copy";

const CATALOGS = { en, fr };

/** What each grouping does — one line under the control. */
const GROUP_BY_HINT = {
  package: "groupBy.hint.package",
  work: "groupBy.hint.work",
  agent: "groupBy.hint.agent",
  time: "groupBy.hint.time",
} as const;

export function ReviewSettings() {
  const t = useT(CATALOGS);
  const prefs = useReviewPreferences();
  return (
    <PageShell>
      <PageHeader title={t("title")} description={t("description")} />
      <div className="flex flex-col gap-4">
        <LanguageSetting />

        <SectionCard
          title={t("groupBy.title")}
          hint={t(GROUP_BY_HINT[prefs.groupBy])}
        >
          {prefs.isLoading ? (
            <ResourceRowSkeleton count={1} />
          ) : prefs.isError ? (
            <p className="text-[12.5px] text-status-down">
              {t("groupBy.unread")}
            </p>
          ) : (
            <FilterChips
              ariaLabel={t("groupBy.title")}
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

        <SectionCard title={t("layout.title")} hint={t("layout.hint")}>
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
                  ariaLabel={t("layout.aria", {
                    name: resolveReviewPackageLabel(pkg),
                  })}
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

/**
 * The person's language (`users.setLocale`). The console re-reads `users.me`
 * and speaks it at once (`ConsoleLocaleProvider`): the page changing language
 * IS the receipt; a failure says so and leaves the choice as it was.
 */
function LanguageSetting() {
  const t = useT(CATALOGS);
  const locale = useConsoleLocale();
  const utils = trpc.useUtils();
  const setLocale = trpc.users.setLocale.useMutation({
    onSuccess: () => void utils.users.me.invalidate(),
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        title: t("language.failed"),
        description: t("language.failedHint"),
        color: "danger",
      });
    },
  });
  return (
    <SectionCard title={t("language.title")} hint={t("language.hint")}>
      <FilterChips
        ariaLabel={t("language.title")}
        className=""
        // The pick shows while the pod saves it; a refused one falls back.
        active={
          setLocale.isPending && setLocale.variables
            ? setLocale.variables.locale
            : locale
        }
        chips={SUPPORTED_LOCALES.map((l) => ({
          key: l,
          label: t(`language.${l}`),
        }))}
        onSelect={(next) => {
          if (next !== locale) setLocale.mutate({ locale: next });
        }}
      />
    </SectionCard>
  );
}

/** The agents the person always lets take hand-offs (B-3). */
function HandOffRules() {
  const t = useT(CATALOGS);
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
          ? t("handOffs.allowed", { name })
          : t("handOffs.asksAgain", { name }),
        color: "success",
      });
    } catch (err) {
      if (err instanceof TRPCClientError && redirectToLoginIfUnauthorized(err))
        return;
      addToast({
        title: t("handOffs.notChanged"),
        description: t("handOffs.notChangedHint"),
        color: "danger",
      });
    } finally {
      setPending(null);
    }
  }

  const rows = agents.data ?? [];
  return (
    <SectionCard title={t("handOffs.title")} hint={t("handOffs.hint")}>
      {agents.isLoading || rules.isLoading ? (
        <ResourceRowSkeleton count={2} />
      ) : agents.isError || rules.isError ? (
        <ResourceRowError
          message={t("handOffs.failed")}
          onRetry={() => {
            void agents.refetch();
            void rules.refetch();
          }}
        />
      ) : rows.length === 0 ? (
        <ResourceRowEmpty message={t("handOffs.empty")} />
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
                  {on ? t("handOffs.on") : t("handOffs.off")}
                </span>
                <Switch
                  size="sm"
                  isSelected={on}
                  isDisabled={pending === a.id}
                  onValueChange={(next) => void toggle(a.id, name, next)}
                  aria-label={t("handOffs.aria", { name })}
                />
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

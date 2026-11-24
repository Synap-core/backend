"use client";

/**
 * `/automations/<rule id>` for a rule the POD applies (a built-in rule, or a
 * roll-up a relation declares; decision D8): the second rung after the
 * Rules list. In order:
 *   1. what it is: its name, on or paused, and its one act (Pause / Turn on,
 *      through the governed rule door, `skills.setReactionRule`; a pause is
 *      the whole pod's, and its confirm says so);
 *   2. what it does: When → Then, in words;
 *   3. what it did lately: applied, proposed (the log's words and a door to
 *      the proposal, whose own page says where it stands), or skipped with
 *      why. Omitted when it has not acted for this reader;
 *   4. its facts: where it comes from, who owns it, what a move into done or
 *      lost does (decision D3), whether its moves set off other rules.
 * One read: `skills.listReactionRules` (the list's own), no second shape.
 */

import { useState } from "react";
import Link from "next/link";
import { addToast, Button } from "@heroui/react";
import { resolveActionLabel } from "@synap-core/types/vocabulary";
import { trpc } from "../../../../lib/trpc";
import { navHref } from "../../../../lib/console-nav";
import {
  PageHeader,
  PageShell,
  PageSkeleton,
} from "../../components/page-header";
import { SectionCard } from "../../components/section-card";
import { StatusPill } from "../../components/status-pill";
import { ConfirmModal } from "../../components/confirm-modal";
import {
  ResourceRowEmpty,
  ResourceRowError,
} from "../../components/resource-row";
import { automationsT } from "./copy";
import { objectPage } from "../../../_lib/object/content/markdown-model";
import {
  reactionOriginLine,
  reactionPauseConsequence,
  reactionOutcomeLine,
  reactionTerminalLine,
  type ReactionRuleWire,
} from "./reaction-rule-rows";

export function PodRuleObject({ id }: { id: string }) {
  const t = automationsT();
  const utils = trpc.useUtils();
  const query = trpc.skills.listReactionRules.useQuery(
    { recent: 20 },
    { staleTime: 15_000 }
  );
  const setRule = trpc.skills.setReactionRule.useMutation();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (query.isLoading) return <PageSkeleton rows={4} />;
  const rule = ((query.data ?? []) as unknown as ReactionRuleWire[]).find(
    (r) => r.id === id
  );

  if (query.isError || !rule) {
    return (
      <PageShell>
        <PageHeader title={t("obj.title")} />
        {query.isError ? (
          <ResourceRowError
            message={t("obj.readFailed")}
            onRetry={() => void query.refetch()}
          />
        ) : (
          <ResourceRowEmpty message={t("obj.missing")} />
        )}
        <Link
          href={navHref("automations")}
          className="mt-4 inline-block text-[13px] underline underline-offset-2"
        >
          {t("obj.back")}
        </Link>
      </PageShell>
    );
  }

  const turnOn = !rule.enabled;
  async function confirmAct() {
    setError(null);
    try {
      const r = await setRule.mutateAsync({ id: rule!.id, on: turnOn });
      addToast({
        title:
          r.status === "proposed"
            ? `Sent “${rule!.title}” for review`
            : turnOn
              ? `${resolveActionLabel("turn_on", "past")} “${rule!.title}”`
              : `Paused “${rule!.title}”`,
        color: "default",
      });
      setConfirming(false);
      await utils.skills.listReactionRules.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn’t work.");
    }
  }

  return (
    <PageShell>
      <Link
        href={navHref("automations")}
        className="mb-3 inline-block text-[12.5px] text-foreground/65 hover:text-foreground"
      >
        {t("obj.crumb")}
      </Link>
      <PageHeader
        title={rule.title}
        description={reactionOriginLine(rule)}
        actions={
          <>
            <StatusPill
              kind={rule.enabled ? "healthy" : "unknown"}
              label={rule.enabled ? t("obj.on") : t("obj.paused")}
            />
            <Button
              size="md"
              variant="flat"
              radius="md"
              onPress={() => {
                setError(null);
                setConfirming(true);
              }}
            >
              {turnOn ? resolveActionLabel("turn_on") : "Pause"}
            </Button>
          </>
        }
      />

      <div className="flex flex-col gap-6">
        <SectionCard variant="flat" title={t("obj.what")}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
            <dt className="text-foreground/65">{t("obj.when")}</dt>
            <dd className="text-foreground">{rule.when}</dd>
            <dt className="text-foreground/65">{t("obj.then")}</dt>
            <dd className="text-foreground">
              {rule.via} {rule.do}
            </dd>
          </dl>
        </SectionCard>

        {rule.recent.length > 0 && (
          <SectionCard
            variant="flat"
            title={t("obj.lately")}
            count={rule.recent.length}
            hint={t("obj.latelyHint")}
          >
            <ul className="flex flex-col gap-3">
              {rule.recent.map((o, i) => {
                const line = reactionOutcomeLine(o);
                return (
                  <li
                    key={`${o.at}-${i}`}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
                  >
                    <StatusPill kind={line.tone} label={line.label} />
                    <span className="min-w-0 flex-1 text-[13px] text-foreground/80 [overflow-wrap:anywhere]">
                      {line.detail}
                      {o.outcome === "proposed" && o.proposalId && (
                        <>
                          {" "}
                          <Link
                            href={
                              objectPage("proposal", o.proposalId) ??
                              `/proposal/${encodeURIComponent(o.proposalId)}`
                            }
                            className="underline underline-offset-2"
                          >
                            {t("obj.openProposal")}
                          </Link>
                        </>
                      )}
                    </span>
                    <span className="text-[12px] text-foreground/65">
                      {line.when}
                    </span>
                  </li>
                );
              })}
            </ul>
          </SectionCard>
        )}

        <SectionCard variant="flat" title={t("obj.about")}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
            <dt className="text-foreground/65">{t("obj.owner")}</dt>
            <dd className="text-foreground">
              {rule.owner?.name ??
                (rule.owner ? "A person in this pod" : "The pod")}
            </dd>
            <dt className="text-foreground/65">{t("obj.doneOrLost")}</dt>
            <dd className="text-foreground">{reactionTerminalLine(rule)}</dd>
            <dt className="text-foreground/65">{t("obj.moves")}</dt>
            <dd className="text-foreground">
              {rule.chains
                ? "Can set off other automations (at most 3 moves deep)."
                : "Set off no other automation."}
            </dd>
          </dl>
        </SectionCard>
      </div>

      <ConfirmModal
        isOpen={confirming}
        onClose={() => {
          setConfirming(false);
          setError(null);
        }}
        onConfirm={() => void confirmAct()}
        title={
          turnOn
            ? `${resolveActionLabel("turn_on")} “${rule.title}”?`
            : `Pause “${rule.title}”?`
        }
        consequence={
          turnOn ? (
            <>{t("obj.turnOn.body")}</>
          ) : (
            <>{reactionPauseConsequence(rule)}</>
          )
        }
        confirmLabel={
          turnOn ? resolveActionLabel("turn_on") : "Pause automation"
        }
        confirmColor="warning"
        isPending={setRule.isPending}
      >
        {error && <p className="text-[12.5px] text-status-down">{error}</p>}
      </ConfirmModal>
    </PageShell>
  );
}

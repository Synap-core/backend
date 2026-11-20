"use client";

/**
 * Approvals › Calibration — what agents did that an approval could change.
 * It moved here from the desktop's Settings › Approvals › Calibration
 * (decision b387ca45 D5: pod admin edits approvals, the desktop and the phone
 * show them). Four patterns, one tab each (`?kind=`), opening on the most
 * alarming one that has rows (`defaultCalibrationKind`):
 *
 *   ungoverned  "Ran with no receipt": `diagnose.ungovernedWrites`, agent
 *               writes that EXECUTED with no proposal at all (nothing was
 *               reviewed, no receipt)                 → Make it ask first
 *   rejected    `proposals.groups` (rejected)       → Mark expected (undone below)
 *   repeats     `proposals.groups` (pending)        → Review together
 *   auto        "Auto-approved" (the vocabulary's status word): `proposals.list`
 *               status auto_approved, requests the gate approved on their own
 *               (an approval row or a pod default), each with its receipt
 *                                                   → Its approval, or Make it ask first
 *
 * "Make it ask first" writes one approval row (this agent × this action, the
 * whole pod → asks first) through the sensitive-action door
 * (`useCreateGovernanceRule`, with the proof of presence), and its receipt
 * opens that row on Approvals. Mark expected is the reader's mute
 * (`proposals.muteRejectionCluster`), listed under the refused tab with its
 * way back. Each read keeps its own error and Retry: a failed read is never
 * shown as "all clear".
 */

import { Button, addToast } from "@heroui/react";
import { ArrowLeft, EyeOff } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import { trpc } from "../../../../lib/trpc";
import { navHref } from "../../../../lib/console-nav";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { readableError } from "../../../../lib/format";
import { useConsoleLocale, useT } from "../../../../lib/i18n/locale-provider";
import { useReplaceParams } from "../../../../lib/use-replace-params";
import {
  CALIBRATION_KINDS,
  askFirstRuleInput,
  autoPatterns,
  defaultCalibrationKind,
  rankPatterns,
  readCalibrationKind,
  rejectedPatterns,
  repeatPatterns,
  ungovernedPatterns,
  type CalibrationKind,
  type CalibrationPattern,
} from "../../../../lib/governance-calibration/calibration-model";
import { useCreateGovernanceRule } from "../../../_lib/presence/use-sensitive-actions";
import { ListCard } from "../../components/list-page";
import {
  PageFallback,
  PageHeader,
  PageShell,
} from "../../components/page-header";
import { ResourceRow } from "../../components/resource-row";
import { SegmentedChoice } from "../../components/segmented-choice";
import { en, fr } from "./_lib/copy";
import { PatternLine, usePatternWho } from "./_lib/pattern-line";

const CATALOGS = { en, fr };
/** Rows drawn before "Show N more" (lists are capped, ui-composition §4). */
const FIRST_ROWS = 10;

export default function CalibrationPage() {
  return (
    <Suspense fallback={<PageFallback />}>
      <CalibrationInner />
    </Suspense>
  );
}

function CalibrationInner() {
  const t = useT(CATALOGS);
  const locale = useConsoleLocale();
  const router = useRouter();
  const params = useSearchParams();
  const replaceParams = useReplaceParams();
  const patternWho = usePatternWho();

  const roster = trpc.agentUsers.list.useQuery({}, { staleTime: 30_000 });
  const ungoverned = trpc.diagnose.ungovernedWrites.useQuery(
    { limit: 100 },
    { staleTime: 30_000 }
  );
  const rejected = trpc.proposals.groups.useQuery(
    { status: "rejected", limit: 40 },
    { staleTime: 30_000 }
  );
  const pending = trpc.proposals.groups.useQuery(
    { status: "pending", limit: 100 },
    { staleTime: 30_000 }
  );
  const auto = trpc.proposals.list.useQuery(
    {
      status: "auto_approved",
      agentOnly: true,
      excludeBookkeeping: true,
      limit: 200,
    },
    { staleTime: 30_000 }
  );
  const mutes = trpc.proposals.listRejectionMutes.useQuery(undefined, {
    staleTime: 30_000,
  });
  useEffect(() => {
    const err =
      ungoverned.error ?? rejected.error ?? pending.error ?? auto.error ?? null;
    if (err) redirectToLoginIfUnauthorized(err);
  }, [ungoverned.error, rejected.error, pending.error, auto.error]);

  const agentNames = useMemo(
    () =>
      new Map(
        (roster.data ?? [])
          .filter((a) => !!a.name)
          .map((a) => [a.id, a.name as string] as const)
      ),
    [roster.data]
  );
  const muted = useMemo(
    () => new Set((mutes.data?.mutes ?? []).map((m) => m.fingerprint)),
    [mutes.data]
  );
  const deps = useMemo(() => ({ agentNames, locale }), [agentNames, locale]);

  const reads = { ungoverned, rejected, repeats: pending, auto } as const;
  const rows: Record<CalibrationKind, CalibrationPattern[] | null> = useMemo(
    () => ({
      ungoverned: ungoverned.data
        ? rankPatterns(ungovernedPatterns(ungoverned.data.writes, deps))
        : null,
      // The mutes must have settled: a muted cluster never flashes in.
      rejected:
        rejected.data && mutes.data
          ? rankPatterns(rejectedPatterns(rejected.data.groups, muted, deps))
          : null,
      repeats: pending.data
        ? rankPatterns(repeatPatterns(pending.data.groups, deps))
        : null,
      auto: auto.data
        ? rankPatterns(autoPatterns(auto.data.items, deps))
        : null,
    }),
    [
      ungoverned.data,
      rejected.data,
      mutes.data,
      pending.data,
      auto.data,
      muted,
      deps,
    ]
  );
  const counts = Object.fromEntries(
    CALIBRATION_KINDS.map((k) => [
      k,
      reads[k].isError ? 0 : (rows[k]?.length ?? null),
    ])
  ) as Record<CalibrationKind, number | null>;

  const asked = readCalibrationKind(params.get("kind"));
  const opening = defaultCalibrationKind(counts);
  const kind: CalibrationKind = asked ?? opening ?? "ungoverned";
  const allSettled = CALIBRATION_KINDS.every((k) => counts[k] !== null);
  const allClear =
    allSettled &&
    CALIBRATION_KINDS.every((k) => counts[k] === 0 && !reads[k].isError);

  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [kind]);
  const shown = rows[kind] ?? [];
  const drawn = expanded ? shown : shown.slice(0, FIRST_ROWS);

  // ── Acting ───────────────────────────────────────────────────────────────
  const utils = trpc.useUtils();
  const createRule = useCreateGovernanceRule();
  const mute = trpc.proposals.muteRejectionCluster.useMutation();
  const unmute = trpc.proposals.unmuteRejectionCluster.useMutation();
  const [busyKey, setBusyKey] = useState<string | null>(null);

  async function act(p: CalibrationPattern) {
    const d = p.decision;
    if (!d || busyKey) return;
    setBusyKey(p.key);
    try {
      if (d.kind === "ask-first") {
        const res = await createRule.mutateAsync(
          askFirstRuleInput(d) as Parameters<typeof createRule.mutateAsync>[0]
        );
        await utils.governanceRules.listAll.invalidate();
        const ruleId = (res as { rule?: { id?: string } } | undefined)?.rule
          ?.id;
        addToast({
          title: t("act.askFirst.done", { who: patternWho(p) }),
          color: "success",
          endContent: ruleId ? (
            <Button
              size="sm"
              variant="flat"
              onPress={() =>
                router.push(navHref("approvals", { focus: ruleId }))
              }
            >
              {t("act.askFirst.open")}
            </Button>
          ) : undefined,
        });
      } else if (d.kind === "mark-expected") {
        await mute.mutateAsync({ fingerprint: d.fingerprint });
        await utils.proposals.listRejectionMutes.invalidate();
        addToast({ title: t("act.markExpected.done"), color: "default" });
      }
    } catch (err) {
      addToast({
        title:
          d.kind === "ask-first"
            ? t("act.askFirst.failed")
            : t("act.markExpected.failed"),
        description: readableError(err instanceof Error ? err.message : null),
        color: "danger",
      });
    } finally {
      setBusyKey(null);
    }
  }

  async function showAgain(fingerprint: string) {
    try {
      await unmute.mutateAsync({ fingerprint });
      await utils.proposals.listRejectionMutes.invalidate();
      addToast({ title: t("muted.undo.done"), color: "default" });
    } catch (err) {
      addToast({
        title: t("muted.failed"),
        description: readableError(err instanceof Error ? err.message : null),
        color: "danger",
      });
    }
  }

  // The muted register names a cluster by the rejected read when it holds it.
  const rejectedByFingerprint = useMemo(() => {
    const all = rejected.data
      ? rejectedPatterns(rejected.data.groups, new Set(), deps)
      : [];
    return new Map(all.map((p) => [p.key, p]));
  }, [rejected.data, deps]);

  // "Auto-approved" is the vocabulary's status word (the backend reads
  // `status: auto_approved`); the other three are this page's own patterns.
  const kindLabel = (k: CalibrationKind) =>
    k === "auto"
      ? resolveStatusLabel("auto_approved", locale)
      : t(`kind.${k as Exclude<CalibrationKind, "auto">}`);
  const read = reads[kind];
  const kindSwitch = (
    <SegmentedChoice<CalibrationKind>
      ariaLabel={t("kind.label")}
      // A view switch, not a filter: the count is the card's, not the tab's.
      options={CALIBRATION_KINDS.map((k) => ({
        key: k,
        label: kindLabel(k),
      }))}
      active={kind}
      onSelect={(next) => replaceParams((p) => p.set("kind", next))}
    />
  );

  return (
    <PageShell>
      <Link
        href={navHref("approvals")}
        className="mb-5 flex w-fit items-center gap-1.5 text-[12.5px] text-foreground/65 transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {t("back")}
      </Link>
      <PageHeader title={t("title")} description={t("description")} />

      {allClear && (
        <p className="mb-4 text-[13px] text-foreground/65">{t("allClear")}</p>
      )}

      <div className="mb-4">{kindSwitch}</div>

      <ListCard
        title={kindLabel(kind)}
        hint={t(`hint.${kind}`)}
        count={read.isError ? null : (rows[kind]?.length ?? null)}
        loading={rows[kind] === null && !read.isError}
        isError={read.isError}
        onRetry={() => void read.refetch()}
        errorMessage={t("list.failed")}
        rowCount={shown.length}
        emptyMessage={t(`list.empty.${kind}`)}
        skeletonRows={4}
        footer={
          drawn.length < shown.length ? (
            <div className="px-1 pt-3">
              <Button
                size="sm"
                variant="light"
                radius="md"
                onPress={() => setExpanded(true)}
              >
                {t("list.more", { count: shown.length - drawn.length })}
              </Button>
            </div>
          ) : undefined
        }
      >
        <div className="-mx-2 divide-y divide-foreground/[0.05]">
          {drawn.map((p) => (
            <PatternLine
              key={p.key}
              pattern={p}
              busy={busyKey === p.key}
              onAct={(x) => void act(x)}
            />
          ))}
        </div>
      </ListCard>

      {kind === "rejected" &&
        (mutes.isError ? (
          <p role="alert" className="mt-4 text-[12.5px] text-status-down">
            {t("muted.failed")}{" "}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => void mutes.refetch()}
            >
              {t("muted.retry")}
            </button>
          </p>
        ) : (mutes.data?.mutes.length ?? 0) > 0 ? (
          <div className="mt-6">
            <ListCard
              title={t("muted.title")}
              count={mutes.data!.mutes.length}
              loading={false}
              isError={false}
              errorMessage={t("muted.failed")}
              rowCount={mutes.data!.mutes.length}
              emptyMessage=""
            >
              <div className="-mx-2 divide-y divide-foreground/[0.05]">
                {mutes.data!.mutes.map((m) => {
                  const p = rejectedByFingerprint.get(m.fingerprint);
                  return (
                    <ResourceRow
                      key={m.fingerprint}
                      Icon={EyeOff}
                      primary={
                        p
                          ? `${patternWho(p)} · ${p.phrase}`
                          : t("muted.unknown")
                      }
                      secondary={p?.targetLabel ?? undefined}
                      wrap
                      actions={
                        <Button
                          size="sm"
                          variant="flat"
                          radius="md"
                          className="min-h-9"
                          isLoading={
                            unmute.isPending &&
                            unmute.variables?.fingerprint === m.fingerprint
                          }
                          onPress={() => void showAgain(m.fingerprint)}
                        >
                          {t("muted.undo")}
                        </Button>
                      }
                    />
                  );
                })}
              </div>
            </ListCard>
          </div>
        ) : null)}
    </PageShell>
  );
}

"use client";

/**
 * Approvals › Daily write limits — the one place pod admin sets how many
 * writes an agent may run on its own per UTC day (`governance_ceilings`, axis
 * `daily_write_count`). It moved here from the desktop's Settings › Approvals
 * › Daily write limits (decision b387ca45 D5: pod admin edits approvals, the
 * desktop and the phone show them).
 *
 *   list      every active limit the reader can see (`governanceCeilings.list`
 *             with `workspaceId: []`: the pod's and every space's), each with
 *             who it caps, where, today's use for one agent's limit
 *             (`usageToday`, the same counter the gate reads), and Take back
 *             (`governanceCeilings.revoke`, re-checked by the pod);
 *   Add limit `governanceCeilings.create`: every agent or one agent, the whole
 *             pod or one space, a whole number of writes per day.
 *
 * A limit is opt-in: with no row there is none. The pod has no update door,
 * so changing a limit is adding the new one and taking the old one back.
 */

import { Button, addToast } from "@heroui/react";
import { ArrowLeft, Plus } from "lucide-react";
import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { trpc } from "../../../../lib/trpc";
import { navHref } from "../../../../lib/console-nav";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { readableError } from "../../../../lib/format";
import { useT } from "../../../../lib/i18n/locale-provider";
import {
  limitSpaceId,
  limitWho,
  type LimitRowLike,
} from "../../../../lib/governance-ceilings/limits-model";
import { ConfirmModal } from "../../components/confirm-modal";
import { ListCard } from "../../components/list-page";
import {
  PageFallback,
  PageHeader,
  PageShell,
} from "../../components/page-header";
import { en, fr } from "./_lib/copy";
import { LimitLine, useWhoWords } from "./_lib/limit-line";
import { AddLimitModal } from "./_lib/add-limit-modal";

const CATALOGS = { en, fr };

export default function DailyWriteLimitsPage() {
  return (
    <Suspense fallback={<PageFallback />}>
      <LimitsInner />
    </Suspense>
  );
}

function LimitsInner() {
  const t = useT(CATALOGS);
  // `[]` = no narrow: the pod's limits and every space the reader can see.
  const limits = trpc.governanceCeilings.list.useQuery(
    { workspaceId: [] },
    { staleTime: 30_000 }
  );
  const agents = trpc.agentUsers.list.useQuery(
    { includeComputers: false },
    { staleTime: 30_000 }
  );
  const spaces = trpc.workspaces.adminListAll.useQuery(undefined, {
    staleTime: 60_000,
  });
  useEffect(() => {
    if (limits.error) redirectToLoginIfUnauthorized(limits.error);
  }, [limits.error]);

  const rows: LimitRowLike[] = limits.data?.ceilings ?? [];
  const agentNames = useMemo(
    () =>
      new Map((agents.data ?? []).map((a) => [a.id, a.name ?? ""] as const)),
    [agents.data]
  );
  const spaceName = useMemo(() => {
    const byId = new Map((spaces.data ?? []).map((s) => [s.id, s.name]));
    return (id: string) => byId.get(id);
  }, [spaces.data]);
  const whoWords = useWhoWords();

  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<LimitRowLike | null>(null);
  const [actError, setActError] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const revoke = trpc.governanceCeilings.revoke.useMutation();

  async function confirmTakeBack() {
    if (!pending) return;
    setActError(null);
    try {
      await revoke.mutateAsync({ id: pending.id });
      addToast({ title: t("takeBack.done"), color: "default" });
      setPending(null);
      await Promise.all([
        utils.governanceCeilings.list.invalidate(),
        utils.governanceCeilings.usageToday.invalidate(),
      ]);
    } catch (err) {
      // The pod's refusal, as it said it: who may take a limit back is its call.
      setActError(
        readableError(err instanceof Error ? err.message : null) ??
          t("takeBack.failed")
      );
    }
  }

  return (
    <PageShell>
      <Link
        href={navHref("approvals")}
        className="mb-5 flex w-fit items-center gap-1.5 text-[12.5px] text-foreground/65 transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {t("back")}
      </Link>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <Button
            size="sm"
            color="primary"
            radius="md"
            startContent={<Plus className="h-3.5 w-3.5" />}
            onPress={() => setAdding(true)}
          >
            {t("add")}
          </Button>
        }
      />

      <ListCard
        title={t("list.title")}
        count={limits.isLoading || limits.isError ? null : rows.length}
        loading={limits.isLoading}
        isError={limits.isError}
        onRetry={() => void limits.refetch()}
        errorMessage={t("list.failed")}
        rowCount={rows.length}
        emptyMessage={t("list.empty")}
        skeletonRows={3}
      >
        <div className="-mx-2 divide-y divide-foreground/[0.05]">
          {rows.map((row) => {
            const spaceId = limitSpaceId(row);
            return (
              <LimitLine
                key={row.id}
                row={row}
                who={limitWho(row, agentNames)}
                where={
                  spaceId === null
                    ? t("where.pod")
                    : (spaceName(spaceId) ?? t("where.space"))
                }
                onTakeBack={() => {
                  setActError(null);
                  setPending(row);
                }}
              />
            );
          })}
        </div>
      </ListCard>

      {adding && (
        <AddLimitModal
          agents={agents}
          spaces={spaces.data ?? []}
          onClose={() => setAdding(false)}
        />
      )}

      <ConfirmModal
        isOpen={pending !== null}
        onClose={() => {
          if (revoke.isPending) return;
          setPending(null);
          setActError(null);
        }}
        onConfirm={() => void confirmTakeBack()}
        title={t("takeBack.title")}
        consequence={
          pending
            ? t("takeBack.consequence", {
                who: whoWords(limitWho(pending, agentNames)),
                limit: pending.limitValue,
              })
            : null
        }
        confirmLabel={t("takeBack.label")}
        confirmColor="warning"
        isPending={revoke.isPending}
      >
        {actError && (
          <p className="text-[12.5px] text-status-down">{actError}</p>
        )}
      </ConfirmModal>
    </PageShell>
  );
}

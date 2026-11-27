"use client";

/**
 * Pod security › Network — the outside sites the pod's AIs may read open
 * data from (`http.get_json`'s allow-list), with who added each, when, why,
 * the approval behind it and the automations that read it.
 *
 * Procedures used:
 *   • trpc.govConfig.allowedHosts — any signed-in member reads; `canManage`
 *                                   says whether this reader may change it
 *   • trpc.govConfig.allowHost    — pod admin, a SENSITIVE action (proof of
 *                                   presence, through `useAllowHost`): runs
 *                                   `http.allow_host` as the person
 *   • trpc.govConfig.revoke       — pod admin, the credential door's step-up;
 *                                   only takes reach away, so no proof
 *
 * An AI never adds a site itself: its `http.allow_host` files a proposal,
 * decided in Review like any other, and lands here with a link to it.
 */

import { Button, Input, Textarea, addToast } from "@heroui/react";
import { TRPCClientError } from "@trpc/client";
import Link from "next/link";
import { ArrowUpRight, Globe, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { formatRelative, readableError } from "../../../../lib/format";
import { useT } from "../../../../lib/i18n/locale-provider";
import { useAllowHost } from "../../../_lib/presence/use-sensitive-actions";
import { ConfirmModal } from "../../components/confirm-modal";
import { FormModal } from "../../components/form-modal";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { SectionCard } from "../../components/section-card";
import { en, fr } from "./network-copy";

const CATALOGS = { en, fr };

interface HostRow {
  id: string;
  host: string;
  addedBy: { id: string; name: string } | null;
  addedAt: Date | string;
  reason: string | null;
  proposalId: string | null;
  usedBy: Array<{ id: string; name: string }>;
}

export function NetworkSection() {
  const t = useT(CATALOGS);
  const list = trpc.govConfig.allowedHosts.useQuery(undefined, {
    staleTime: 30_000,
  });

  // Expired session → login, not a dead "couldn't load" error.
  useEffect(() => {
    if (list.isError) redirectToLoginIfUnauthorized(list.error);
  }, [list.isError, list.error]);
  const isAuthRedirecting = list.error?.data?.code === "UNAUTHORIZED";

  const [adding, setAdding] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<HostRow | null>(null);

  const hosts = (list.data?.hosts ?? []) as HostRow[];
  const canManage = list.data?.canManage === true;
  const unread = list.data?.unreadAutomations ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <SectionCard
        title={t("network.title")}
        hint={t("network.hint")}
        count={list.data ? hosts.length : null}
        actions={
          canManage ? (
            <Button
              size="sm"
              radius="md"
              variant="flat"
              startContent={<Plus className="h-3.5 w-3.5" />}
              onPress={() => setAdding(true)}
            >
              {t("network.add")}
            </Button>
          ) : null
        }
      >
        <div className="divide-y divide-foreground/[0.05] rounded-lg bg-foreground/[0.02] ring-1 ring-inset ring-foreground/10">
          {list.isLoading || isAuthRedirecting ? (
            <ResourceRowSkeleton count={2} />
          ) : list.isError ? (
            <ResourceRowError
              message={t("network.failed")}
              onRetry={() => void list.refetch()}
            />
          ) : hosts.length === 0 ? (
            <ResourceRowEmpty message={t("network.empty")} />
          ) : (
            hosts.map((row) => (
              <HostItem
                key={row.id}
                row={row}
                canManage={canManage}
                onRemove={() => setRemoveTarget(row)}
              />
            ))
          )}
        </div>

        {list.data && unread > 0 && (
          <p className="mt-3 text-[12px] text-foreground/65">
            {t("network.unread", { n: unread })}
          </p>
        )}
        {list.data && !canManage && (
          <p className="mt-3 text-[12px] text-foreground/65">
            {t("network.adminOnly")}
          </p>
        )}
      </SectionCard>

      {adding && <AddHostModal onClose={() => setAdding(false)} />}
      <RemoveHostModal
        target={removeTarget}
        onClose={() => setRemoveTarget(null)}
      />
    </div>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────

function HostItem({
  row,
  canManage,
  onRemove,
}: {
  row: HostRow;
  canManage: boolean;
  onRemove: () => void;
}) {
  const t = useT(CATALOGS);
  const when = formatRelative(row.addedAt);
  const added = row.addedBy
    ? t("network.addedBy", { name: row.addedBy.name, when })
    : t("network.addedWhen", { when });
  const used =
    row.usedBy.length > 0
      ? t("network.usedBy", {
          n: row.usedBy.length,
          names: row.usedBy.map((u) => u.name).join(", "),
        })
      : t("network.notUsed");

  return (
    <div data-row-id={row.id}>
      <ResourceRow
        Icon={Globe}
        primary={row.host}
        wrap
        secondary={
          <>
            {added}
            {row.proposalId && (
              <>
                {" · "}
                <Link
                  href={`/proposal/${encodeURIComponent(row.proposalId)}`}
                  className="inline-flex items-center gap-0.5 font-medium text-primary underline-offset-2 hover:underline"
                >
                  {t("network.approval")}
                  <ArrowUpRight className="h-3 w-3" aria-hidden />
                </Link>
              </>
            )}
          </>
        }
        actions={
          canManage ? (
            <Button
              size="sm"
              variant="flat"
              color="danger"
              radius="md"
              onPress={onRemove}
              startContent={<Trash2 className="h-3.5 w-3.5" />}
            >
              {t("network.remove")}
            </Button>
          ) : undefined
        }
      />
      <div className="-mt-1 flex flex-col gap-0.5 px-3 pb-3 pl-10 text-[12px] text-foreground/65">
        {row.reason && <p>{t("network.why", { reason: row.reason })}</p>}
        <p>{used}</p>
      </div>
    </div>
  );
}

// ─── Add ──────────────────────────────────────────────────────────────────

function AddHostModal({ onClose }: { onClose: () => void }) {
  const t = useT(CATALOGS);
  const utils = trpc.useUtils();
  const [host, setHost] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The proof of presence is asked here, bound to this exact host.
  const allow = useAllowHost();

  async function submit() {
    setError(null);
    try {
      const out = await allow.mutateAsync({
        host: host.trim(),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      await utils.govConfig.allowedHosts.invalidate();
      addToast({
        title: t(
          out.alreadyAllowed ? "network.alreadyAllowed" : "network.added",
          {
            host: out.host,
          }
        ),
        color: "success",
      });
      onClose();
    } catch (err) {
      if (err instanceof TRPCClientError && redirectToLoginIfUnauthorized(err))
        return;
      setError(
        readableError(err instanceof Error ? err.message : null) ??
          t("network.form.failed")
      );
    }
  }

  return (
    <FormModal
      title={t("network.form.title")}
      submitLabel={t("network.form.submit")}
      isPending={allow.isPending}
      canSubmit={host.trim().length > 0}
      error={error}
      onSubmit={() => void submit()}
      onClose={() => {
        if (!allow.isPending) onClose();
      }}
    >
      <Input
        autoFocus
        size="sm"
        radius="md"
        variant="bordered"
        label={t("network.form.host")}
        description={t("network.form.hostHint")}
        value={host}
        onValueChange={setHost}
        autoComplete="off"
        spellCheck="false"
      />
      <Textarea
        size="sm"
        radius="md"
        variant="bordered"
        label={t("network.form.reason")}
        description={t("network.form.reasonHint")}
        value={reason}
        onValueChange={setReason}
        minRows={2}
        maxLength={1000}
      />
    </FormModal>
  );
}

// ─── Remove ───────────────────────────────────────────────────────────────

function RemoveHostModal({
  target,
  onClose,
}: {
  target: HostRow | null;
  onClose: () => void;
}) {
  const t = useT(CATALOGS);
  const utils = trpc.useUtils();
  const revoke = trpc.govConfig.revoke.useMutation();
  // Kept while the dialog plays its exit, so its words never blank out.
  const [shown, setShown] = useState<HostRow | null>(target);
  useEffect(() => {
    if (target) setShown(target);
  }, [target]);

  async function remove() {
    if (!target) return;
    try {
      await revoke.mutateAsync({
        store: "config_settings",
        targetId: target.id,
      });
      await utils.govConfig.allowedHosts.invalidate();
      addToast({
        title: t("network.removed", { host: target.host }),
        color: "default",
      });
      onClose();
    } catch (err) {
      if (err instanceof TRPCClientError && redirectToLoginIfUnauthorized(err))
        return;
      addToast({
        title: t("network.removeFailed"),
        description: readableError(err instanceof Error ? err.message : null),
        color: "danger",
      });
    }
  }

  const host = shown?.host ?? "";
  const users = shown?.usedBy.length ?? 0;
  return (
    <ConfirmModal
      isOpen={target !== null}
      onClose={onClose}
      onConfirm={() => void remove()}
      title={t("network.remove.title", { host })}
      consequence={
        users > 0
          ? t("network.remove.consequenceUsed", { host, n: users })
          : t("network.remove.consequence", { host })
      }
      confirmLabel={t("network.remove.confirm")}
      isPending={revoke.isPending}
    />
  );
}

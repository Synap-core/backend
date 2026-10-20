"use client";

/**
 * /my-notifications — what may interrupt YOU on your phone, and which of
 * your phones get it. Self-service, like `/my-computers`: every call is a
 * `protectedProcedure` floored on the caller (`notifCenter.pushPrefs` /
 * `setPushPrefs` / `listDevices` / `revokeDevice`), so a member sees and
 * turns off only their own phones — and a pod admin has no view of anyone
 * else's (a phone is a personal delivery address).
 *
 * Turning a phone off here is `revoked`: it stays off when the app opens
 * again, until the person turns notifications back on from that phone.
 * Quiet hours are not here yet.
 */

import { Suspense, useEffect, useState } from "react";
import { Button, Switch, addToast } from "@heroui/react";
import { Smartphone } from "lucide-react";
import {
  PUSH_DEVICE_COPY,
  type EffectivePushCategory,
  type PushDeviceView,
} from "@synap-core/types/push";
import { trpc } from "../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../lib/auth-redirect";
import { readableError } from "../../lib/format";
import { navHref, navLabel } from "../../lib/console-nav";
import {
  PageHeader,
  PageShell,
  PageSkeleton,
} from "../(admin)/components/page-header";
import { ConfirmModal } from "../(admin)/components/confirm-modal";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../(admin)/components/resource-row";
import { SectionCard } from "../(admin)/components/section-card";
import { useFocusRow } from "../(admin)/components/use-focus-row";
import { Breadcrumbs } from "../_lib/object/object-header";
import {
  categoryRows,
  phonePill,
  phoneSecondary,
  phoneViews,
  phonesSummary,
  turnOffCopy,
} from "./_lib/devices-model";

const CRUMBS = [
  { label: navLabel("home"), href: navHref("home") },
  { label: "My notifications" },
];

export default function MyNotificationsPage() {
  return (
    <Suspense
      fallback={
        <PageShell width="personal">
          <PageSkeleton />
        </PageShell>
      }
    >
      <MyNotificationsInner />
    </Suspense>
  );
}

function MyNotificationsInner() {
  const prefs = trpc.notifCenter.pushPrefs.useQuery(undefined, {
    staleTime: 30_000,
  });
  const devices = trpc.notifCenter.listDevices.useQuery(undefined, {
    staleTime: 30_000,
  });

  useEffect(() => {
    if (devices.isError) redirectToLoginIfUnauthorized(devices.error);
  }, [devices.isError, devices.error]);
  const isAuthRedirecting = devices.error?.data?.code === "UNAUTHORIZED";

  return (
    <PageShell width="personal">
      <div className="mb-3">
        <Breadcrumbs crumbs={CRUMBS} />
      </div>
      <PageHeader
        title="My notifications"
        description="What can interrupt you on your phone, and which phones get it. Everything else waits for you in the app."
      />
      <div className="flex flex-col gap-5">
        <CategoriesSection
          categories={prefs.data?.categories}
          isLoading={prefs.isLoading}
          isError={prefs.isError}
          onRetry={() => void prefs.refetch()}
        />
        <PhonesSection
          rows={devices.data}
          isLoading={devices.isLoading || isAuthRedirecting}
          isError={devices.isError && !isAuthRedirecting}
          onRetry={() => void devices.refetch()}
        />
      </div>
    </PageShell>
  );
}

function CategoriesSection({
  categories,
  isLoading,
  isError,
  onRetry,
}: {
  categories: readonly EffectivePushCategory[] | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}) {
  const utils = trpc.useUtils();
  const set = trpc.notifCenter.setPushPrefs.useMutation({
    onSuccess: (data) => utils.notifCenter.pushPrefs.setData(undefined, data),
    onError: (err) =>
      addToast({
        title: "Couldn't change that",
        description: readableError(err.message),
        color: "danger",
      }),
  });
  const rows = categoryRows(categories);
  const pendingCategory = set.isPending
    ? Object.keys(set.variables?.categories ?? {})[0]
    : undefined;

  return (
    <SectionCard
      title="What reaches your phone"
      hint="Each one is a push to every phone below that is on."
    >
      {isLoading ? (
        <ResourceRowSkeleton count={4} />
      ) : isError ? (
        <ResourceRowError
          message="Couldn't load your push settings."
          onRetry={onRetry}
        />
      ) : (
        <ul className="-mx-2 divide-y divide-foreground/[0.05]">
          {rows.map((c) => (
            <li
              key={c.category}
              className="flex min-h-14 items-center gap-3 px-3 py-2"
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-[13px] font-medium text-foreground">
                  {c.name}
                </span>
                {c.hint && (
                  <span className="text-[11.5px] text-foreground/65">
                    {c.hint}
                  </span>
                )}
              </div>
              <Switch
                size="sm"
                isSelected={c.enabled}
                isDisabled={pendingCategory === c.category}
                onValueChange={(on) =>
                  set.mutate({ categories: { [c.category]: on } })
                }
                aria-label={c.name}
              />
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function PhonesSection({
  rows,
  isLoading,
  isError,
  onRetry,
}: {
  rows: Parameters<typeof phoneViews>[0];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}) {
  const utils = trpc.useUtils();
  const [confirming, setConfirming] = useState<PushDeviceView | null>(null);
  const views = phoneViews(rows);
  useFocusRow({ ready: !isLoading && !!rows });

  const revoke = trpc.notifCenter.revokeDevice.useMutation({
    onSuccess: async () => {
      setConfirming(null);
      await utils.notifCenter.listDevices.invalidate();
      addToast({ title: "Notifications stopped", color: "default" });
    },
    onError: (err) => {
      setConfirming(null);
      addToast({
        title: "Couldn't stop notifications",
        description: readableError(err.message),
        color: "danger",
      });
    },
  });
  const ready = !isLoading && !isError;
  const copy = confirming ? turnOffCopy(confirming) : null;

  return (
    <SectionCard
      title="Your phones"
      hint={
        ready && views.length > 0
          ? `${phonesSummary(views)} Only you see this list.`
          : undefined
      }
    >
      {isLoading ? (
        <ResourceRowSkeleton count={2} />
      ) : isError ? (
        <ResourceRowError
          message="Couldn't load your phones."
          onRetry={onRetry}
        />
      ) : views.length === 0 ? (
        <ResourceRowEmpty message={PUSH_DEVICE_COPY.empty} />
      ) : (
        <div className="-mx-2 divide-y divide-foreground/[0.05]">
          {views.map((v) => (
            <div
              key={v.id}
              data-row-id={v.id}
              className="rounded-md transition-shadow"
            >
              <ResourceRow
                Icon={Smartphone}
                primary={v.label}
                secondary={phoneSecondary(v)}
                status={phonePill(v)}
                wrap
                actions={
                  v.canTurnOff ? (
                    <Button
                      size="sm"
                      radius="md"
                      variant="flat"
                      className="min-h-10"
                      aria-label={`${PUSH_DEVICE_COPY.turnOffAction} to ${v.label}`}
                      onPress={() => setConfirming(v)}
                    >
                      {PUSH_DEVICE_COPY.turnOffAction}
                    </Button>
                  ) : undefined
                }
              />
              {v.state !== "on" && (
                <p className="px-3 pb-2.5 pl-10 text-[12px] leading-relaxed text-foreground/65">
                  {v.explain}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {copy && confirming && (
        <ConfirmModal
          isOpen
          onClose={() => setConfirming(null)}
          onConfirm={() => revoke.mutate({ id: confirming.id })}
          title={copy.title}
          consequence={copy.consequence}
          confirmLabel={copy.confirmLabel}
          confirmColor="warning"
          isPending={revoke.isPending && revoke.variables?.id === confirming.id}
        />
      )}
    </SectionCard>
  );
}

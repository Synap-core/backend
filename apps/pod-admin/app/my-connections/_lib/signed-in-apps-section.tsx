"use client";

/**
 * "Signed-in apps": the Synap apps (Synap Desktop, Synap Relay) the person
 * signed in to this Pod, one row per sign-in, each with Sign out. The ONE
 * list of sign-ins: the phones under /my-notifications are notification
 * targets, not sign-ins, and stay there. Rows, words and order come from
 * `@synap-core/types/sign-in`, which the apps read too.
 *
 * `devices.revoke` only ever takes access away, so it answers `revoked` and
 * never a proposal; a stale sign-in on another device answers NOT_FOUND.
 */

import { useState } from "react";
import { Button, Card, CardBody, Chip, Spinner, addToast } from "@heroui/react";
import { Ban, Monitor, Smartphone } from "lucide-react";
import {
  SIGNED_IN_APPS_COPY,
  compareSignedInDevices,
  signedInDeviceView,
  type SignedInDeviceView,
} from "@synap-core/types/sign-in";
import { ConfirmModal } from "../../(admin)/components/confirm-modal";
import { trpc } from "../../../lib/trpc";
import { formatRelative } from "../../../lib/format";

export function SignedInAppsSection() {
  const devices = trpc.devices.list.useQuery();
  const utils = trpc.useUtils();
  const [pending, setPending] = useState<SignedInDeviceView | null>(null);
  const views = (devices.data ?? [])
    .map(signedInDeviceView)
    .sort(compareSignedInDevices);
  const signOut = trpc.devices.revoke.useMutation({
    onSuccess: async (_res, { deviceId }) => {
      const title = views.find((v) => v.id === deviceId)?.title ?? "";
      setPending(null);
      await utils.devices.list.invalidate();
      addToast({ title: SIGNED_IN_APPS_COPY.signedOut(title) });
    },
    onError: async (err) => {
      setPending(null);
      await utils.devices.list.invalidate();
      addToast({
        title: "Couldn't sign it out",
        description: err.message,
        color: "danger",
      });
    },
  });

  return (
    <section className="mb-9 space-y-3" aria-labelledby="signed-in-apps">
      <div className="flex items-center justify-between gap-3">
        <h2 id="signed-in-apps" className="text-sm font-medium text-foreground">
          {SIGNED_IN_APPS_COPY.title}
        </h2>
        {devices.data ? (
          <span className="text-xs text-foreground/65">{views.length}</span>
        ) : null}
      </div>

      {devices.isError ? (
        <div
          role="alert"
          className="rounded-lg border border-foreground/10 px-4 py-3"
        >
          <p className="text-xs text-danger">
            Couldn&apos;t load your signed-in apps.
          </p>
          <Button
            size="sm"
            variant="flat"
            className="mt-2 min-h-10"
            isLoading={devices.isFetching}
            onPress={() => void devices.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : devices.isLoading ? (
        <div className="flex items-center gap-3 px-1 py-3 text-sm text-foreground/65">
          <Spinner size="sm" /> Loading your signed-in apps
        </div>
      ) : views.length === 0 ? (
        <div className="rounded-lg border border-dashed border-foreground/15 px-4 py-5 text-sm text-foreground/65">
          <p className="font-medium text-foreground/80">
            {SIGNED_IN_APPS_COPY.empty}
          </p>
          <p className="mt-1">{SIGNED_IN_APPS_COPY.emptyWhy}</p>
        </div>
      ) : (
        views.map((view) => (
          <SignedInAppRow
            key={view.id}
            view={view}
            isSigningOut={
              signOut.isPending && signOut.variables?.deviceId === view.id
            }
            onSignOut={() => setPending(view)}
          />
        ))
      )}

      <ConfirmModal
        isOpen={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => {
          if (pending) signOut.mutate({ deviceId: pending.id });
        }}
        title={SIGNED_IN_APPS_COPY.signOutTitle(pending?.title ?? "")}
        consequence={
          <p>
            {SIGNED_IN_APPS_COPY.signOutConsequence(pending?.appName ?? "")}
          </p>
        }
        confirmLabel={SIGNED_IN_APPS_COPY.signOutAction}
        isPending={
          signOut.isPending && signOut.variables?.deviceId === pending?.id
        }
      />
    </section>
  );
}

export function SignedInAppRow({
  view,
  isSigningOut,
  onSignOut,
}: {
  view: SignedInDeviceView;
  isSigningOut: boolean;
  onSignOut: () => void;
}) {
  const Mark = view.kind === "computer" ? Monitor : Smartphone;
  return (
    <Card shadow="none" className="border border-foreground/10 bg-content1">
      <CardBody className="flex-row items-center justify-between gap-3 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Mark
            size={18}
            className="mt-0.5 shrink-0 text-foreground/70"
            aria-label={view.appName}
          />
          <div className="min-w-0">
            <p className="break-words text-sm font-medium">{view.title}</p>
            <p className="mt-1 text-xs text-foreground/65">
              {view.title === view.appName ? null : `${view.appName} · `}
              last used {formatRelative(view.lastActiveAt)}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {view.isThisDevice ? (
            <Chip size="sm" variant="flat" color="primary">
              {SIGNED_IN_APPS_COPY.thisDevice}
            </Chip>
          ) : null}
          <Button
            color="danger"
            size="sm"
            variant="flat"
            className="min-h-10"
            startContent={<Ban size={14} />}
            isLoading={isSigningOut}
            onPress={onSignOut}
          >
            {SIGNED_IN_APPS_COPY.signOutAction}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

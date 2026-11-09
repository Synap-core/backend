"use client";

/**
 * "I lost my passkey" (`CONSOLE_PAGES.presenceRecovery`): the ONE recovery
 * door of proof of presence. Every presence dialog links here (pod admin,
 * Relay, the desktop app, the web app); no surface runs its own.
 *
 * Ask → every device of the person is told and can cancel for 24 h → Finish
 * (a fresh sign-in at the pod) clears every proof factor → add a passkey
 * again. Each step is the pod's (`presence.recovery.*`), audited there. The
 * states are derived in `presence-recovery-model.ts`.
 */

import { useState } from "react";
import Link from "next/link";
import { Button, Card, CardBody } from "@heroui/react";
import { LifeBuoy } from "lucide-react";
import { trpc } from "../../../lib/trpc";
import { formatRelative, formatTimestamp } from "../../../lib/format";
import { useT } from "../../../lib/i18n/locale-provider";
import { ConfirmModal } from "../../(admin)/components/confirm-modal";
import { PASSKEYS_PATH } from "../../settings/security/passkeys-path";
import { WAYS_IN_HREF } from "../../_lib/presence/ways-in/ways-in-model";
import { en, fr } from "./presence-recovery-copy";
import {
  needsFreshSignIn,
  presenceRecoveryView,
} from "./presence-recovery-model";

const CATALOGS = { en, fr };

const HERE = "/recovery/presence";
const SIGN_IN_HREF = `/login?return=${encodeURIComponent(HERE)}`;
const SIGN_IN_AGAIN_HREF = `/login?refresh=1&return=${encodeURIComponent(HERE)}`;

export function PresenceRecoveryView() {
  const t = useT(CATALOGS);
  const utils = trpc.useUtils();
  const status = trpc.presence.recovery.status.useQuery(undefined, {
    retry: false,
  });
  const request = trpc.presence.recovery.request.useMutation();
  const cancel = trpc.presence.recovery.cancel.useMutation();
  const complete = trpc.presence.recovery.complete.useMutation();
  const [confirm, setConfirm] = useState<"ask" | "finish" | null>(null);
  /** The last step the pod refused, kept on the page until acted on. */
  const [refused, setRefused] = useState<{
    message: string;
    signIn: boolean;
  } | null>(null);

  const view = presenceRecoveryView(status);

  const run = async (step: () => Promise<unknown>) => {
    setConfirm(null);
    setRefused(null);
    try {
      await step();
    } catch (err) {
      setRefused({
        message: err instanceof Error ? err.message : "",
        signIn: needsFreshSignIn(err),
      });
    }
    await Promise.all([
      utils.presence.recovery.status.invalidate(),
      utils.presence.factors.invalidate(),
    ]);
  };

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-10">
      <h1 className="flex items-center gap-2 text-[20px] font-semibold">
        <LifeBuoy aria-hidden className="h-5 w-5 text-primary" />
        {t("presence.lost")}
      </h1>
      <p className="text-[13.5px] text-foreground/80">{t("intro")}</p>
      <p className="text-[12.5px] text-foreground/60">{t("email")}</p>

      <Card shadow="none" className="ring-1 ring-inset ring-foreground/10">
        <CardBody className="flex flex-col gap-3 p-4 text-[13px]">
          {view.kind === "loading" && (
            <div className="h-12 rounded-medium bg-foreground/[0.05] shimmer-pulse" />
          )}

          {view.kind === "signedOut" && (
            <div className="flex flex-wrap items-center gap-3">
              <p>{t("signedOut")}</p>
              <Button as="a" href={SIGN_IN_HREF} color="primary" radius="md">
                {t("signIn")}
              </Button>
            </div>
          )}

          {view.kind === "failed" && (
            <div className="flex flex-col items-start gap-2">
              <p className="text-status-down">{t("failed")}</p>
              {view.detail && (
                <p className="text-[12px] text-foreground/45">{view.detail}</p>
              )}
              <Button
                size="sm"
                variant="flat"
                radius="md"
                onPress={() => void status.refetch()}
              >
                {t("retry")}
              </Button>
            </div>
          )}

          {view.kind === "none" && (
            <div className="flex flex-col items-start gap-2">
              {view.cancelledAt && (
                <p className="text-foreground/65">
                  {t("none.cancelled", {
                    when: formatRelative(view.cancelledAt),
                  })}
                </p>
              )}
              <Button
                color="primary"
                radius="md"
                isLoading={request.isPending}
                onPress={() => setConfirm("ask")}
              >
                {t("none.ask")}
              </Button>
            </div>
          )}

          {view.kind === "waiting" && (
            <div className="flex flex-col items-start gap-2">
              <p className="font-medium">{t("waiting.title")}</p>
              <p className="text-foreground/75">
                {t("waiting.body", {
                  when: `${formatTimestamp(view.maturesAt)} (${formatRelative(view.maturesAt)})`,
                })}
              </p>
              <Button
                color="danger"
                variant="flat"
                radius="md"
                isLoading={cancel.isPending}
                onPress={() => void run(() => cancel.mutateAsync())}
              >
                {t("waiting.cancel")}
              </Button>
            </div>
          )}

          {view.kind === "ready" && (
            <div className="flex flex-col items-start gap-2">
              <p className="font-medium">{t("ready.title")}</p>
              <p className="text-foreground/75">{t("ready.body")}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  color="primary"
                  radius="md"
                  isLoading={complete.isPending}
                  onPress={() => setConfirm("finish")}
                >
                  {t("ready.finish")}
                </Button>
                <Button
                  variant="flat"
                  radius="md"
                  isLoading={cancel.isPending}
                  onPress={() => void run(() => cancel.mutateAsync())}
                >
                  {t("waiting.cancel")}
                </Button>
              </div>
            </div>
          )}

          {view.kind === "done" && (
            <div className="flex flex-col items-start gap-2">
              <p className="font-medium">{t("done.title")}</p>
              <p className="text-foreground/75">{t("done.body")}</p>
              {complete.data &&
                (!complete.data.signedOut.listed ||
                  complete.data.signedOut.failed > 0) && (
                  <p role="alert" className="text-[12.5px] text-warning-600">
                    {t("done.signOutFailed")}
                  </p>
                )}
              <div className="flex flex-wrap gap-2">
                <Button
                  as={Link}
                  href={PASSKEYS_PATH}
                  color="primary"
                  radius="md"
                >
                  {t("done.addPasskey")}
                </Button>
                <Button
                  as={Link}
                  href={WAYS_IN_HREF}
                  variant="flat"
                  radius="md"
                >
                  {t("done.addSecond")}
                </Button>
              </div>
            </div>
          )}

          {refused && (
            <div className="flex flex-col items-start gap-2 border-t border-foreground/[0.06] pt-3">
              <p role="alert" className="text-[12.5px] text-status-down">
                {refused.signIn ? t("ready.signIn") : t("notChanged")}{" "}
                {!refused.signIn && refused.message && (
                  <span className="text-foreground/65">{refused.message}</span>
                )}
              </p>
              {refused.signIn && (
                <Button
                  as="a"
                  href={SIGN_IN_AGAIN_HREF}
                  size="sm"
                  variant="flat"
                  radius="md"
                >
                  {t("ready.signInAction")}
                </Button>
              )}
            </div>
          )}
        </CardBody>
      </Card>

      <ConfirmModal
        isOpen={confirm === "ask"}
        onClose={() => setConfirm(null)}
        onConfirm={() => void run(() => request.mutateAsync())}
        title={t("ask.title")}
        consequence={t("ask.consequence")}
        confirmLabel={t("ask.confirm")}
        confirmColor="primary"
      />
      <ConfirmModal
        isOpen={confirm === "finish"}
        onClose={() => setConfirm(null)}
        onConfirm={() => void run(() => complete.mutateAsync())}
        title={t("ready.confirm.title")}
        consequence={t("ready.confirm.consequence")}
        confirmLabel={t("ready.confirm")}
        confirmColor="danger"
      />
    </main>
  );
}

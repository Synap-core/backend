"use client";

/**
 * What became of a secret handed over for an ask (plan d717d6ac §4,
 * `focusSessions.provideSecretUse`): how often the agent read it, when
 * last, until when — and Take back, which revokes that grant
 * (`secretsVault.revokeGrant`).
 *
 * Its state is the pod's own (`secretUseState`): "Taken back" only when the
 * grant was revoked; a grant that ran out reads "Used up" or "Ended <at>".
 * Taking back a STANDING grant (one the agent held before this ask) ends its
 * access for all its work, so it is said and confirmed first. A failed read
 * says so; never "not read".
 */

import { useState } from "react";
import { Button, Spinner, addToast } from "@heroui/react";
import { resolveActionLabel } from "@synap-core/types/vocabulary";
import { trpc } from "../../../../lib/trpc";
import { formatRelative, readableError } from "../../../../lib/format";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { useT } from "../../../../lib/i18n/locale-provider";
import { REQUEST_CATALOGS } from "../../../_lib/request/copy";
import { ConfirmModal } from "../../components/confirm-modal";
import { secretUseState } from "./provide-options";

export function SecretHandedOver({
  slot,
  onDone,
}: {
  /** The slot it was handed over for (`slotCall`): its session and label. */
  slot: { sessionId: string; expectedLabel: string };
  onDone: () => void;
}) {
  const t = useT(REQUEST_CATALOGS);
  const { sessionId, expectedLabel } = slot;
  const use = trpc.focusSessions.provideSecretUse.useQuery(
    { sessionId, expectedLabel },
    { retry: 1, refetchInterval: 30_000 }
  );
  const utils = trpc.useUtils();
  const [confirming, setConfirming] = useState(false);
  const revoke = trpc.secretsVault.revokeGrant.useMutation({
    onSuccess: () => {
      setConfirming(false);
      addToast({ color: "success", title: t("secret.takenBack") });
      void utils.focusSessions.provideSecretUse.invalidate({
        sessionId,
        expectedLabel,
      });
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        color: "danger",
        title: t("secret.takeBackFailed"),
        description: readableError(err.message) ?? undefined,
      });
    },
  });
  const read = use.data;
  const found = read?.status === "ok" ? read.use : null;
  const state = found ? secretUseState(found) : null;
  const until = !found
    ? null
    : found.uses === "standing"
      ? t("secret.untilStanding")
      : found.uses === "once"
        ? t("secret.untilOnce")
        : t("secret.untilSession");

  return (
    <section data-secret-handed-over="" className="flex flex-col gap-2">
      {use.isError ? (
        <p className="flex flex-wrap items-center gap-2 text-[12.5px] text-status-stale">
          {t("secret.useUnreadable")}
          <Button
            size="sm"
            variant="light"
            className="min-h-11"
            onPress={() => void use.refetch()}
          >
            {t("story.retry")}
          </Button>
        </p>
      ) : use.isLoading ? (
        <Spinner size="sm" />
      ) : found && state ? (
        <>
          <p className="text-[14px] font-medium text-foreground">
            {found.secretName}
          </p>
          <p
            data-secret-use={state.kind}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-foreground/80"
          >
            <span>{t("secret.used", { n: found.useCount })}</span>
            {found.lastUsedAt && (
              <>
                <span aria-hidden>·</span>
                <span>
                  {t("secret.lastAt", {
                    at: formatRelative(found.lastUsedAt, { empty: "" }),
                  })}
                </span>
              </>
            )}
            <span aria-hidden>·</span>
            {state.kind === "active" ? (
              <>
                <span>{until}</span>
                <Button
                  variant="bordered"
                  className="rq-refuse min-h-11"
                  isLoading={revoke.isPending}
                  onPress={() =>
                    state.standing
                      ? setConfirming(true)
                      : revoke.mutate({ grantId: state.grantId })
                  }
                >
                  {t("secret.takeBack")}
                </Button>
              </>
            ) : state.kind === "takenBack" ? (
              <span className="font-medium">{t("secret.takenBack")}</span>
            ) : state.kind === "usedUp" ? (
              <span className="font-medium">{t("secret.usedUp")}</span>
            ) : (
              <span className="font-medium">
                {state.at
                  ? t("secret.ended", { at: formatRelative(state.at) })
                  : t("secret.endedNoTime")}
              </span>
            )}
          </p>
          {state.kind === "active" && state.standing && (
            <ConfirmModal
              isOpen={confirming}
              onClose={() => setConfirming(false)}
              onConfirm={() => revoke.mutate({ grantId: state.grantId })}
              title={t("secret.takeBackStandingTitle", {
                name: found.secretName,
                agent: found.agentName,
              })}
              consequence={t("secret.takeBackStanding", {
                agent: found.agentName,
              })}
              confirmLabel={t("secret.takeBack")}
              isPending={revoke.isPending}
            />
          )}
        </>
      ) : null}
      <div>
        <Button size="sm" variant="light" className="min-h-11" onPress={onDone}>
          {resolveActionLabel("close", "imperative")}
        </Button>
      </div>
    </section>
  );
}

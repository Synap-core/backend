"use client";

/**
 * "Approvals need you in person": the pod's proof-of-presence mode, a row of
 * Pod security. Pod admin RUNS the pod, so the switch lives here.
 *
 *  - The read is `presence.mode`: the mode, where it comes from, and what
 *    `report` let through in the last 30 days, each kind a door to the audit
 *    log. A failed read is its own state with Try again, never a calm OFF.
 *  - Turning it ON is free on the pod. It asks first only when the person
 *    holds no factor (`presence.factors`) to turn it off again with, and then
 *    offers the door to add a passkey.
 *  - Turning it OFF asks for the person's proof (`presence_mode:report`,
 *    through `app/_lib/presence`), and the confirm says every pod admin is
 *    told.
 *  - The operator's env floor holds it ON: the switch is locked and says why.
 *
 * The switch is the mark: a change that lands says nothing more. A refusal
 * stays on the card with Try again (rule feedback-and-forms §1); declining
 * the passkey changes nothing and says nothing (the dialog already did).
 */

import { useState } from "react";
import Link from "next/link";
import { Button, Switch } from "@heroui/react";
import { Fingerprint } from "lucide-react";
import { trpc } from "../../../../lib/trpc";
import { formatRelative } from "../../../../lib/format";
import { useT } from "../../../../lib/i18n/locale-provider";
import {
  PresenceDeclined,
  presenceRefusal,
} from "../../../_lib/presence/presence-model";
import { useSetPresenceMode } from "../../../_lib/presence/use-factor-doors";
import { PASSKEYS_PATH } from "../../../settings/security/passkeys-path";
import { ConfirmModal } from "../../components/confirm-modal";
import { SectionCard } from "../../components/section-card";
import { StatusPill } from "../../components/status-pill";
import { en, fr } from "./copy";
import { presenceModeView, turningOnAsks } from "./presence-mode-model";

const CATALOGS = { en, fr };

type Mode = "enforce" | "report";

export function PresenceModeCard() {
  const t = useT(CATALOGS);
  const utils = trpc.useUtils();
  const read = trpc.presence.mode.useQuery(undefined, { retry: false });
  const factors = trpc.presence.factors.useQuery(undefined, { retry: false });
  const [confirm, setConfirm] = useState<"on" | "off" | null>(null);
  /** The last change the pod refused, kept on the card until acted on. */
  const [refused, setRefused] = useState<{
    mode: Mode;
    presence: boolean;
  } | null>(null);
  const setMode = useSetPresenceMode({
    onSuccess: () => {
      setRefused(null);
      void utils.presence.mode.invalidate();
    },
    onError: (err, input) => {
      if (err instanceof PresenceDeclined) return;
      setRefused({ mode: input.mode, presence: presenceRefusal(err) !== null });
    },
  });

  // The confirm closes first: turning it off then opens the passkey dialog,
  // never a dialog over a dialog. The switch holds while the pod saves.
  const change = (mode: Mode) => {
    setConfirm(null);
    setRefused(null);
    setMode.mutate({ mode });
  };
  const onSwitch = (on: boolean) => {
    if (on && !turningOnAsks(factors)) change("enforce");
    else setConfirm(on ? "on" : "off");
  };

  const view = read.data ? presenceModeView(read.data) : null;

  return (
    <SectionCard
      title={t("presence.setting")}
      hint={t("presence.hint", {
        sensitive: t("presence.sensitive"),
        where: t("presence.where"),
      })}
      actions={
        view ? (
          <StatusPill
            kind={view.mark.kind}
            label={t(view.mark.word)}
            icon={Fingerprint}
          />
        ) : null
      }
    >
      {read.isLoading ? (
        <div className="h-16 rounded-medium bg-foreground/[0.05] shimmer-pulse" />
      ) : read.isError || !view ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-[12.5px] text-status-down">
            {t("presence.failed")}
          </p>
          <Button
            size="sm"
            variant="flat"
            radius="md"
            onPress={() => void read.refetch()}
          >
            {t("presence.retry")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="text-[13px] text-foreground/85">{t(view.line)}</p>
              <p className="text-[12px] text-foreground/55">
                {view.source.word === "presence.source.changed"
                  ? t(view.source.word, {
                      when: formatRelative(view.source.at),
                    })
                  : t(view.source.word)}
              </p>
            </div>
            <Switch
              size="sm"
              isSelected={view.on}
              isDisabled={!view.canSwitch || setMode.isPending}
              onValueChange={onSwitch}
              aria-label={t("presence.setting")}
            />
          </div>

          {refused && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <p role="alert" className="text-[12.5px] text-status-down">
                {t(
                  refused.presence ? "presence.refused" : "presence.notChanged"
                )}{" "}
                <span className="text-foreground/65">
                  {t("presence.notChangedHint")}
                </span>
              </p>
              <Button
                size="sm"
                variant="flat"
                radius="md"
                onPress={() => change(refused.mode)}
              >
                {t("presence.retry")}
              </Button>
            </div>
          )}

          <div className="flex flex-col gap-1.5 border-t border-foreground/[0.05] pt-3">
            <p className="text-[12px] text-foreground/65">
              {view.missing.word === "presence.missing.none"
                ? t(view.missing.word)
                : t(view.missing.word, { n: view.missing.total })}
            </p>
            {view.missing.rows.length > 0 && (
              <ul className="flex flex-col gap-0.5 text-[12px] text-foreground/65">
                {view.missing.rows.map((r) => (
                  <li key={r.kind}>
                    {r.href ? (
                      <Link
                        href={r.href}
                        className="flex min-h-8 items-baseline justify-between gap-3 rounded-md px-1 -mx-1 hover:bg-foreground/[0.04] hover:text-foreground"
                      >
                        <span className="min-w-0 truncate">{r.label}</span>
                        <span className="tabular-nums text-foreground/80">
                          {r.count}
                        </span>
                      </Link>
                    ) : (
                      <span className="flex min-h-8 items-baseline justify-between gap-3">
                        <span className="min-w-0 truncate">{r.label}</span>
                        <span className="tabular-nums text-foreground/80">
                          {r.count}
                        </span>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {view.missing.showAll && (
              <Button
                as={Link}
                href={view.missing.showAll.href}
                size="sm"
                variant="light"
                radius="md"
                className="self-start"
              >
                {t("presence.missing.showAll", { n: view.missing.showAll.n })}
              </Button>
            )}
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={confirm === "on"}
        onClose={() => setConfirm(null)}
        onConfirm={() => change("enforce")}
        title={t("presence.on.title")}
        consequence={
          <>
            {t("presence.on.consequence")}{" "}
            <Link
              href={PASSKEYS_PATH}
              className="font-medium text-primary underline-offset-2 hover:underline"
            >
              {t("presence.on.addPasskey")}
            </Link>
          </>
        }
        confirmLabel={t("presence.on.confirm")}
        confirmColor="primary"
      />
      <ConfirmModal
        isOpen={confirm === "off"}
        onClose={() => setConfirm(null)}
        onConfirm={() => change("report")}
        title={t("presence.off.title")}
        consequence={t("presence.off.consequence")}
        confirmLabel={t("presence.off.confirm")}
        confirmColor="danger"
      />
    </SectionCard>
  );
}

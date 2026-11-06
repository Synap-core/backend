"use client";

/**
 * "Approvals need you in person": the pod's proof-of-presence mode (W3 slice
 * 3, backend#827), a Settings row of Pod security. Pod admin RUNS the pod, so
 * the switch lives here.
 *
 *  - The read is `presence.mode`: the mode, where it comes from, and what
 *    `report` let through in the last 30 days. A failed read is its own
 *    state with Try again, never a calm OFF switch.
 *  - Turning it ON is free on the pod; the confirm says that turning it off
 *    again needs a passkey or Relay's Face ID, so nobody locks themself out.
 *  - Turning it OFF asks for the person's proof (`presence_mode:report`,
 *    through `app/_lib/presence`), and the confirm says every pod admin is
 *    told.
 *  - The operator's env floor holds it ON: the switch is locked and says why.
 *
 * The switch is the mark: a change that lands says nothing more; a refusal
 * says so in one toast; declining the passkey changes nothing and says
 * nothing (the dialog already did).
 */

import { useState } from "react";
import { Button, Switch, addToast } from "@heroui/react";
import { Fingerprint } from "lucide-react";
import { trpc } from "../../../../lib/trpc";
import { formatRelative, readableError } from "../../../../lib/format";
import { useT } from "../../../../lib/i18n/locale-provider";
import { PresenceDeclined } from "../../../_lib/presence/presence-model";
import { useSetPresenceMode } from "../../../_lib/presence/use-factor-doors";
import { ConfirmModal } from "../../components/confirm-modal";
import { SectionCard } from "../../components/section-card";
import { StatusPill } from "../../components/status-pill";
import { en, fr } from "./copy";
import { presenceModeView } from "./presence-mode-model";

const CATALOGS = { en, fr };

export function PresenceModeCard() {
  const t = useT(CATALOGS);
  const utils = trpc.useUtils();
  const read = trpc.presence.mode.useQuery(undefined, { retry: false });
  const [confirm, setConfirm] = useState<"on" | "off" | null>(null);
  const [showAll, setShowAll] = useState(false);
  const setMode = useSetPresenceMode({
    onSuccess: () => void utils.presence.mode.invalidate(),
    onError: (err) => {
      if (err instanceof PresenceDeclined) return;
      addToast({
        title: t("presence.notChanged"),
        description: readableError(err.message) ?? t("presence.notChangedHint"),
        color: "danger",
      });
    },
  });

  // The confirm closes first: turning it off then opens the passkey dialog,
  // never a dialog over a dialog. The switch holds while the pod saves.
  const change = (mode: "enforce" | "report") => {
    setConfirm(null);
    setMode.mutate({ mode });
  };

  const view = read.data ? presenceModeView(read.data, { showAll }) : null;

  return (
    <SectionCard
      title={t("presence.title")}
      hint={t("presence.hint")}
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
              onValueChange={(on) => setConfirm(on ? "on" : "off")}
              aria-label={t("presence.switch")}
            />
          </div>

          <div className="flex flex-col gap-1.5 border-t border-foreground/[0.05] pt-3">
            <p className="text-[12px] text-foreground/65">
              {t(view.missing.word, { n: view.missing.total })}
            </p>
            {view.missing.rows.length > 0 && (
              <ul className="flex flex-col gap-0.5 text-[12px] text-foreground/65">
                {view.missing.rows.map((r) => (
                  <li
                    key={r.label}
                    className="flex items-baseline justify-between gap-3"
                  >
                    <span className="min-w-0 truncate">{r.label}</span>
                    <span className="tabular-nums text-foreground/80">
                      {r.count}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {view.missing.more > 0 && (
              <Button
                size="sm"
                variant="light"
                radius="md"
                className="self-start"
                onPress={() => setShowAll(true)}
              >
                {t("presence.missing.showAll")}
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
            <a
              href="#passkeys"
              // Your passkeys are on this page (W5): close, then scroll there.
              onClick={() => setConfirm(null)}
              className="font-medium text-primary underline-offset-2 hover:underline"
            >
              {t("presence.on.passkeys")}
            </a>
          </>
        }
        confirmLabel={t("presence.on.confirm")}
        confirmColor="warning"
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

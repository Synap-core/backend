"use client";

/**
 * "Add this device", the NEW device's view (founder decision of 9 Nov 2026):
 * the two-digit number to pick on a device the person already uses, the time
 * left, Cancel; then one clear action per state (`link-model.ts`). Drawn in
 * two places: the proof-of-presence dialog ("Set up this device", when this
 * browser cannot prove) and the passkeys card ("Approve from another
 * device"; the Relay-only step).
 *
 * `onDone`: this device now holds its passkey (the person pressed
 * Continue). `onCancel`: the person left the panel; the open request was
 * declined first.
 */
import { Button } from "@heroui/react";
import { AlertCircle, CheckCircle2, Smartphone } from "lucide-react";
import { useT } from "../../../../lib/i18n/locale-provider";
import { CopyButton } from "../../copy-button";
import { PasskeyPlacementMenu } from "../../passkey-placement/passkey-placement-menu";
import { presenceT } from "../copy";
import { en, fr } from "./copy";
import { timeLeft, type LinkState } from "./link-model";
import { useDeviceLink } from "./use-device-link";

const CATALOGS = { en, fr };

/** Where "Sign in again" brings the person back: this page. */
function reauthHref(): string {
  const here =
    typeof window === "undefined"
      ? "/settings/security"
      : `${window.location.pathname}${window.location.search}`;
  return `/login?refresh=1&return=${encodeURIComponent(here)}`;
}

export function DeviceLinkPanel({
  onDone,
  onCancel,
}: {
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useT(CATALOGS);
  const { state, now, ask, readAgain, create, cancel } = useDeviceLink();
  const leave = () => {
    cancel();
    onCancel();
  };

  return (
    <section
      aria-labelledby="device-link-title"
      className="flex flex-col gap-3 rounded-large bg-content2/40 p-4 ring-1 ring-inset ring-foreground/[0.06]"
      data-device-link-panel=""
    >
      <h3
        id="device-link-title"
        className="flex items-center gap-2 text-[13.5px] font-semibold text-foreground"
      >
        <Smartphone aria-hidden className="h-4 w-4 text-primary" />
        {t("panel.title")}
      </h3>
      <PanelBody
        state={state}
        now={now}
        onAsk={() => void ask()}
        onReadAgain={readAgain}
        onCreate={(placement) => void create(placement)}
        onDone={onDone}
      />
      {state.kind !== "done" ? (
        <div>
          <Button size="sm" radius="md" variant="light" onPress={leave}>
            {t("panel.cancel")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function PanelBody({
  state,
  now,
  onAsk,
  onReadAgain,
  onCreate,
  onDone,
}: {
  state: LinkState;
  now: number;
  onAsk: () => void;
  onReadAgain: () => void;
  onCreate: Parameters<typeof PasskeyPlacementMenu>[0]["onChoose"];
  onDone: () => void;
}) {
  const t = useT(CATALOGS);
  const left = (iso: string | null) => {
    const l = timeLeft(iso, now);
    if (!l) return null;
    return (
      <p className="text-[12px] tabular-nums text-foreground/55">
        {l.unit === "minutes"
          ? t("panel.left.minutes", { n: l.n })
          : t("panel.left.seconds", { n: l.n })}
      </p>
    );
  };
  const failure = (message: string, detail?: string | null) => (
    <div className="flex flex-col items-start gap-1">
      <p
        role="alert"
        className="flex items-start gap-2 text-[12.5px] text-status-down"
      >
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {message}
      </p>
      {detail ? (
        <CopyButton
          text={detail}
          label={t("panel.copyDetails")}
          variant="light"
          ariaLabel={t("panel.copyDetails.aria")}
        />
      ) : null}
    </div>
  );

  switch (state.kind) {
    case "asking":
      return (
        <p role="status" className="text-[12.5px] text-foreground/55">
          {t("panel.asking")}
        </p>
      );
    case "waiting":
    case "status-failed":
      return (
        <div className="flex flex-col gap-2">
          <p
            aria-live="polite"
            className="font-heading text-[40px] font-semibold leading-none tracking-tight text-foreground tabular-nums"
            data-device-link-number=""
          >
            <span className="sr-only">
              {t("panel.number.aria", { number: state.number })}
            </span>
            <span aria-hidden>{state.number}</span>
          </p>
          <p className="text-[13px] text-foreground/80">
            {t("panel.instruction", { number: state.number })}
          </p>
          {left(state.expiresAt)}
          {state.kind === "status-failed" ? (
            <div className="flex flex-col items-start gap-2">
              {failure(t("panel.statusFailed"), state.detail)}
              <Button
                size="sm"
                radius="md"
                variant="flat"
                onPress={onReadAgain}
              >
                {t("panel.tryAgain")}
              </Button>
            </div>
          ) : null}
        </div>
      );
    case "approved":
    case "creating":
    case "create-failed":
      return (
        <div className="flex flex-col items-start gap-2">
          <p className="text-[13px] text-foreground/80">
            {state.id === null ? t("panel.firstWay") : t("panel.approved")}
          </p>
          {state.kind === "create-failed"
            ? failure(
                state.reason === "refused"
                  ? t("panel.create.refused")
                  : presenceT()(`create.${state.reason}`),
                state.detail
              )
            : null}
          <PasskeyPlacementMenu
            button={{ size: "sm", radius: "md", color: "primary" }}
            isLoading={state.kind === "creating"}
            onChoose={onCreate}
          >
            {t("panel.create")}
          </PasskeyPlacementMenu>
          {state.kind !== "creating" ? left(state.expiresAt) : null}
        </div>
      );
    case "done":
      return (
        <div className="flex flex-col items-start gap-2">
          <p
            role="status"
            className="flex items-start gap-2 text-[13px] text-foreground/85"
          >
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            {t("panel.done")}
          </p>
          <Button
            size="sm"
            radius="md"
            color="primary"
            autoFocus
            onPress={onDone}
          >
            {t("panel.continue")}
          </Button>
        </div>
      );
    case "declined":
    case "expired":
      return (
        <div className="flex flex-col items-start gap-2">
          <p role="status" className="text-[13px] text-foreground/80">
            {state.kind === "declined"
              ? t("panel.declined")
              : t("panel.expired")}
          </p>
          <Button size="sm" radius="md" color="primary" onPress={onAsk}>
            {t("panel.askAgain")}
          </Button>
        </div>
      );
    case "request-failed":
      return (
        <div className="flex flex-col items-start gap-2">
          {failure(t("panel.requestFailed"), state.detail)}
          <Button size="sm" radius="md" variant="flat" onPress={onAsk}>
            {t("panel.tryAgain")}
          </Button>
        </div>
      );
    case "rate-limited":
      return (
        <p role="status" className="text-[13px] text-foreground/80">
          {t("panel.rateLimited")}
        </p>
      );
    case "no-session":
    case "reauth":
      return (
        <div className="flex flex-col items-start gap-2">
          <p role="status" className="text-[13px] text-foreground/80">
            {state.kind === "no-session"
              ? t("panel.noSession")
              : t("panel.reauth")}
          </p>
          <Button
            as="a"
            href={reauthHref()}
            size="sm"
            radius="md"
            variant="flat"
          >
            {t("panel.signInAgain")}
          </Button>
        </div>
      );
  }
}

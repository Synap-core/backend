"use client";

/**
 * "Add this device", on a device the person ALREADY uses (founder decision
 * of 9 Nov 2026): each new device asking, with the three numbers to pick
 * from (the one the new device shows is among them) and "Not me", then one
 * receipt per answer. Drawn above every admin page (`banner`, from the admin
 * shell) and at the top of the person's Security page (`page`).
 *
 * Nothing is drawn when nobody asks. A failed read is a quiet line with Try
 * again on the Security page only, never a banner on every page
 * (`requestsShown`).
 */
import { Button } from "@heroui/react";
import type { TFunction } from "@synap-core/types/i18n";
import { AlertCircle, CheckCircle2, ShieldQuestion, X } from "lucide-react";
import { useT } from "../../../../lib/i18n/locale-provider";
import { en, fr } from "./copy";
import {
  receiptIsFailure,
  requestsShown,
  type RequestReceipt,
  type RequestsPlacement,
} from "./requests-model";
import { useDeviceLinkRequests } from "./use-device-link-requests";

const CATALOGS = { en, fr };

/** A receipt's sentence; the two that name the device take its label. */
function receiptText(
  t: TFunction<typeof en>,
  receipt: RequestReceipt,
  label: string
): string {
  switch (receipt) {
    case "approved":
      return t("requests.approved", { label });
    case "declined":
      return t("requests.declined", { label });
    case "mismatch":
      return t("requests.mismatch");
    case "gone":
      return t("requests.gone");
    case "self":
      return t("requests.self");
    case "failed":
      return t("requests.failed");
    case "declineFailed":
      return t("requests.declineFailed");
  }
}

export function DeviceLinkRequests({
  placement,
}: {
  placement: RequestsPlacement;
}) {
  const t = useT(CATALOGS);
  const { view, retry, receipts, busyId, pick, notMe, dismiss } =
    useDeviceLinkRequests();
  const shown = requestsShown(view, placement);
  if (!shown && receipts.length === 0) return null;

  const body = (
    <section
      aria-label={t("requests.region")}
      className="flex flex-col gap-3"
      data-device-link-requests={placement}
    >
      {shown === "failed" ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="flex items-start gap-2 text-[12.5px] text-foreground/60">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t("requests.readFailed")}
          </p>
          <Button size="sm" radius="md" variant="flat" onPress={retry}>
            {t("requests.retry")}
          </Button>
        </div>
      ) : null}

      {shown === "rows" && view.kind === "ready"
        ? view.rows.map((row) => {
            const busy = busyId === row.id;
            return (
              <div
                key={row.id}
                className="flex flex-col gap-3 rounded-large bg-warning/10 p-4 ring-1 ring-inset ring-warning/30"
                data-device-link-request={row.id}
              >
                <div className="flex items-start gap-3">
                  <ShieldQuestion
                    aria-hidden
                    className="mt-0.5 h-5 w-5 shrink-0 text-warning"
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <p className="text-[13.5px] font-medium text-foreground">
                      {t("requests.title", { label: row.label })}
                    </p>
                    <p className="text-[12.5px] text-foreground/65">
                      {t("requests.pick")}
                    </p>
                    <p className="text-[12px] tabular-nums text-foreground/55">
                      {t("requests.left", { minutes: row.minutesLeft })}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:pl-8">
                  {row.choices.map((n) => (
                    <Button
                      key={n}
                      size="md"
                      radius="md"
                      variant="flat"
                      isDisabled={busyId !== null}
                      aria-label={t("requests.number.aria", { number: n })}
                      className="min-w-14 font-heading text-[17px] font-semibold tabular-nums"
                      onPress={() => void pick(row.id, n)}
                    >
                      {n}
                    </Button>
                  ))}
                  <Button
                    size="sm"
                    radius="md"
                    variant="light"
                    color="danger"
                    isDisabled={busyId !== null}
                    isLoading={busy}
                    onPress={() => void notMe(row.id)}
                  >
                    {t("requests.notMe")}
                  </Button>
                </div>
              </div>
            );
          })
        : null}

      {receipts.map(({ id, label, receipt }) => {
        const failure = receiptIsFailure(receipt);
        const Icon = receipt === "approved" ? CheckCircle2 : AlertCircle;
        return (
          <div
            key={id}
            role={failure ? "alert" : "status"}
            className="flex items-start gap-2 rounded-medium bg-content2/40 px-3 py-2 text-[12.5px] text-foreground/80 ring-1 ring-inset ring-foreground/[0.06]"
          >
            <Icon
              aria-hidden
              className={[
                "mt-0.5 h-3.5 w-3.5 shrink-0",
                receipt === "approved"
                  ? "text-success"
                  : failure
                    ? "text-status-down"
                    : "text-foreground/50",
              ].join(" ")}
            />
            <span className="min-w-0 flex-1">
              {receiptText(t, receipt, label)}
            </span>
            <Button
              isIconOnly
              size="sm"
              radius="md"
              variant="light"
              aria-label={t("requests.dismiss")}
              className="-my-1 h-7 w-7 min-w-7"
              onPress={() => dismiss(id)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        );
      })}
    </section>
  );

  // Above an admin page: in the page's own column, so its edge never shifts.
  return placement === "banner" ? (
    <div className="mx-auto max-w-[1100px] px-4 pt-6 sm:px-6">{body}</div>
  ) : (
    <div className="mb-6">{body}</div>
  );
}

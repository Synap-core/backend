"use client";

/**
 * "Phones and computers": the person's device keys, Face ID on Relay and
 * Touch ID in the desktop app, listed with when each was added and last
 * used, and removable from here (finding 020455d5: a lost phone could only be
 * removed from the phone itself). Enrolment stays on the device: the key is
 * made there and never leaves it.
 *
 *  - Read: `presence.devices.list`. A failed read is its own state with Try
 *    again, never "None yet".
 *  - Remove: a confirm, then `presence.devices.revoke`. Removing only takes
 *    power away, so it needs no proof; the pod refuses it below two ways in
 *    under `enforce` (`PRESENCE_NEEDS_TWO_WAYS`), and the refusal stays on
 *    the card with the way forward.
 */
import { useState } from "react";
import { Button, addToast } from "@heroui/react";
import { Smartphone } from "lucide-react";
import { SectionCard } from "../../../(admin)/components/section-card";
import { ConfirmModal } from "../../../(admin)/components/confirm-modal";
import { trpc } from "../../../../lib/trpc";
import { formatRelative } from "../../../../lib/format";
import { useT } from "../../../../lib/i18n/locale-provider";
import { en, fr } from "./copy";
import { isTwoWaysRefusal } from "./ways-in-model";

const CATALOGS = { en, fr };

export const DEVICE_KEYS_ANCHOR = "devices";

interface DeviceKeyRow {
  id: string;
  label: string;
  createdAt: string | Date;
  lastUsedAt: string | Date | null;
}

export function DeviceKeysCard() {
  const t = useT(CATALOGS);
  const utils = trpc.useUtils();
  const list = trpc.presence.devices.list.useQuery(undefined, {
    retry: false,
  });
  const revoke = trpc.presence.devices.revoke.useMutation();
  const [asking, setAsking] = useState<DeviceKeyRow | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const doRemove = async (row: DeviceKeyRow) => {
    setAsking(null);
    setRefusal(null);
    try {
      await revoke.mutateAsync({ id: row.id });
      addToast({ title: t("devices.removed"), color: "default" });
      await Promise.all([
        utils.presence.devices.list.invalidate(),
        utils.presence.factors.invalidate(),
      ]);
    } catch (err) {
      setRefusal(
        isTwoWaysRefusal(err) ? t("devices.twoWays") : t("devices.notRemoved")
      );
    }
  };

  const rows = (list.data ?? []) as DeviceKeyRow[];

  return (
    <div id={DEVICE_KEYS_ANCHOR} className="scroll-mt-6">
      <SectionCard
        title={t("devices.title")}
        hint={t("devices.hint")}
        count={list.isError || list.isLoading ? undefined : rows.length}
      >
        {list.isLoading ? (
          <div className="h-10 rounded-medium bg-foreground/[0.05] shimmer-pulse" />
        ) : list.isError ? (
          <div className="flex flex-col items-start gap-2">
            <p role="alert" className="text-[12.5px] text-status-down">
              {t("devices.failed")}
            </p>
            <Button
              size="sm"
              variant="flat"
              radius="md"
              onPress={() => void list.refetch()}
            >
              {t("devices.retry")}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {rows.length === 0 ? (
              <p className="text-[13px] text-foreground/60">
                {t("devices.none")}
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-foreground/[0.06]">
                {rows.map((row) => (
                  <li
                    key={row.id}
                    className="flex items-center gap-3 py-2 first:pt-0 last:pb-0"
                  >
                    <Smartphone
                      className="h-4 w-4 shrink-0 text-foreground/50"
                      aria-hidden
                    />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[13px] text-foreground">
                        {row.label}
                      </span>
                      <span className="text-[12px] text-foreground/55">
                        {t("devices.added", {
                          when: formatRelative(row.createdAt),
                        })}
                        {row.lastUsedAt
                          ? ` · ${t("devices.used", {
                              when: formatRelative(row.lastUsedAt),
                            })}`
                          : ""}
                      </span>
                    </div>
                    <Button
                      size="sm"
                      variant="light"
                      radius="md"
                      isDisabled={revoke.isPending}
                      onPress={() => setAsking(row)}
                    >
                      {t("devices.remove")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {refusal && (
              <p role="alert" className="text-[12.5px] text-status-down">
                {refusal}
              </p>
            )}
          </div>
        )}
      </SectionCard>
      <ConfirmModal
        isOpen={asking !== null}
        onClose={() => setAsking(null)}
        onConfirm={() => asking && void doRemove(asking)}
        title={t("devices.remove.title", { label: asking?.label ?? "" })}
        consequence={t("devices.remove.consequence")}
        confirmLabel={t("devices.remove.confirm")}
        confirmColor="danger"
      />
    </div>
  );
}

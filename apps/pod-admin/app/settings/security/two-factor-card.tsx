"use client";

/**
 * The person's 2FA app (the recovery ladder, founder, 6 Nov 2026): one more
 * way to confirm it's you, typed only in pod admin's presence dialog. Under
 * `enforce` a person keeps two ways in, so a lost passkey never locks them
 * out (`presenceWaysIn`, `@synap-core/types/presence`).
 *
 *  - Add: `presence.totp.begin` (a fresh sign-in at the pod) shows the secret
 *    ONCE, as a QR code and as text; the app's first code confirms it
 *    (`presence.totp.confirm`), with a proof from a factor the person already
 *    holds (`useConfirmTotp`).
 *  - Remove: a confirm, then `presence.totp.remove`; the pod refuses it below
 *    two ways in under `enforce`, and the refusal stays on the card.
 *
 * Its anchor `#two-factor` is where the "two ways in" lines link.
 */

import { useMemo, useState } from "react";
import { Button, Input, addToast } from "@heroui/react";
import { KeyRound } from "lucide-react";
import { encode } from "uqr";
import { SectionCard } from "../../(admin)/components/section-card";
import { StatusPill } from "../../(admin)/components/status-pill";
import { ConfirmModal } from "../../(admin)/components/confirm-modal";
import { CopyButton } from "../../_lib/copy-button";
import { trpc } from "../../../lib/trpc";
import { formatRelative } from "../../../lib/format";
import { useT } from "../../../lib/i18n/locale-provider";
import { PresenceDeclined } from "../../_lib/presence/presence-model";
import { useConfirmTotp } from "../../_lib/presence/use-factor-doors";
import { en, fr } from "./two-factor-copy";
import { TWO_FACTOR_ANCHOR } from "./two-factor-path";

const CATALOGS = { en, fr };

const REAUTH_HREF = `/login?refresh=1&return=${encodeURIComponent(`/settings/security#${TWO_FACTOR_ANCHOR}`)}`;

interface Refusal {
  message: string;
  reauth: boolean;
}

/** A pod refusal, kept on the card: its words, and whether a fresh sign-in is the way on. */
function refusalOf(err: unknown): Refusal {
  const data = (err as { data?: { reasonCode?: unknown } | null } | null)?.data;
  return {
    message: err instanceof Error && err.message ? err.message : "",
    reauth: data?.reasonCode === "STEP_UP_REQUIRED",
  };
}

export function TwoFactorCard() {
  const t = useT(CATALOGS);
  const utils = trpc.useUtils();
  const app = trpc.presence.totp.get.useQuery(undefined, { retry: false });
  const begin = trpc.presence.totp.begin.useMutation();
  const remove = trpc.presence.totp.remove.useMutation();
  const confirmTotp = useConfirmTotp();
  const [setup, setSetup] = useState<{
    id: string;
    secret: string;
    otpauthUri: string;
  } | null>(null);
  const [code, setCode] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [askRemove, setAskRemove] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const qr = useMemo(
    () => (setup ? encode(setup.otpauthUri, { border: 1 }) : null),
    [setup]
  );

  const changed = async () => {
    await Promise.all([
      utils.presence.totp.get.invalidate(),
      utils.presence.factors.invalidate(),
    ]);
  };

  const start = async () => {
    setRefused(null);
    try {
      const s = await begin.mutateAsync({ label: t("totp.defaultLabel") });
      setCode("");
      setSetup(s);
    } catch (err) {
      setRefused(refusalOf(err));
    }
  };

  const confirmApp = async () => {
    if (!setup) return;
    setRefused(null);
    setConfirming(true);
    try {
      await confirmTotp({ id: setup.id, code: code.replace(/\s+/g, "") });
      // The secret leaves memory: the card's state and the mutation's cache.
      begin.reset();
      setSetup(null);
      setCode("");
      addToast({ title: t("totp.addedToast"), color: "success" });
      await changed();
    } catch (err) {
      // Declining the proof changes nothing and says nothing more.
      if (!(err instanceof PresenceDeclined)) setRefused(refusalOf(err));
    } finally {
      setConfirming(false);
    }
  };

  const doRemove = async () => {
    setAskRemove(false);
    setRefused(null);
    try {
      await remove.mutateAsync();
      await changed();
    } catch (err) {
      setRefused(refusalOf(err));
    }
  };

  const inUse = app.data ?? null;

  return (
    <div id={TWO_FACTOR_ANCHOR}>
      <SectionCard
        title={t("totp.title")}
        hint={t("totp.hint")}
        actions={
          app.isSuccess ? (
            <StatusPill
              kind={inUse ? "healthy" : "stale"}
              label={t(inUse ? "totp.inUse" : "totp.none")}
              icon={KeyRound}
            />
          ) : null
        }
      >
        {app.isLoading ? (
          <div className="h-10 rounded-medium bg-foreground/[0.05] shimmer-pulse" />
        ) : app.isError ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-[12.5px] text-status-down">
              {t("totp.loadFailed")}
            </p>
            <Button
              size="sm"
              variant="flat"
              radius="md"
              onPress={() => void app.refetch()}
            >
              {t("totp.retry")}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {inUse ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-[13px] text-foreground/80">
                  {t("totp.added", {
                    label: inUse.label,
                    when: formatRelative(String(inUse.createdAt)),
                  })}
                </p>
                <Button
                  size="sm"
                  variant="flat"
                  color="danger"
                  radius="md"
                  isLoading={remove.isPending}
                  onPress={() => setAskRemove(true)}
                >
                  {t("totp.remove")}
                </Button>
              </div>
            ) : setup && qr ? (
              <div className="flex flex-col gap-3">
                <p className="text-[13px] text-foreground/80">
                  {t("totp.scan")}
                </p>
                {/* Drawn from the encoded modules: no markup is injected. */}
                <svg
                  viewBox={`0 0 ${qr.size} ${qr.size}`}
                  className="h-44 w-44 rounded-medium bg-white p-2"
                  role="img"
                  aria-label={t("totp.scan")}
                  shapeRendering="crispEdges"
                >
                  {qr.data.flatMap((row, y) =>
                    row.map((dark, x) =>
                      dark ? (
                        <rect
                          key={`${x}-${y}`}
                          x={x}
                          y={y}
                          width={1}
                          height={1}
                          fill="black"
                        />
                      ) : null
                    )
                  )}
                </svg>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12px] text-foreground/55">
                    {t("totp.key")}
                  </span>
                  <code className="break-all font-mono text-[12.5px]">
                    {setup.secret}
                  </code>
                  <CopyButton text={setup.secret} label={t("totp.copyKey")} />
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <Input
                    size="sm"
                    className="max-w-[12rem]"
                    label={t("totp.code")}
                    value={code}
                    onValueChange={setCode}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void confirmApp();
                    }}
                  />
                  <Button
                    color="primary"
                    radius="md"
                    isLoading={confirming}
                    isDisabled={!/^\d{6}$/.test(code.replace(/\s+/g, ""))}
                    onPress={() => void confirmApp()}
                  >
                    {t("totp.confirm")}
                  </Button>
                  <Button
                    variant="light"
                    radius="md"
                    isDisabled={confirming}
                    onPress={() => {
                      begin.reset();
                      setSetup(null);
                      setRefused(null);
                    }}
                  >
                    {t("totp.cancel")}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                className="self-start"
                color="primary"
                radius="md"
                isLoading={begin.isPending}
                onPress={() => void start()}
              >
                {t("totp.add")}
              </Button>
            )}
            {refused && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <p role="alert" className="text-[12.5px] text-status-down">
                  {t("totp.failed")}{" "}
                  <span className="text-foreground/65">{refused.message}</span>
                </p>
                {refused.reauth && (
                  <Button
                    as="a"
                    href={REAUTH_HREF}
                    size="sm"
                    variant="flat"
                    radius="md"
                  >
                    {t("totp.reauth")}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </SectionCard>
      <ConfirmModal
        isOpen={askRemove}
        onClose={() => setAskRemove(false)}
        onConfirm={() => void doRemove()}
        title={t("totp.remove.title")}
        consequence={t("totp.remove.consequence")}
        confirmLabel={t("totp.remove.confirm")}
        confirmColor="danger"
      />
    </div>
  );
}

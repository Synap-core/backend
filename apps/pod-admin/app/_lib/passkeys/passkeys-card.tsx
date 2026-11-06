"use client";

/**
 * "Your passkeys": the ONE card that lists, adds and removes the signed-in
 * person's passkeys (W5, founder 6 Nov 2026: "handle (add/remove) passkeys
 * (seem to not be possible for now on the security setting when we talk
 * about the passkey)"). Shown on settings Security (`/settings/security`)
 * and on pod admin Security (`/security`), which before W5 had no passkey
 * card at all, only a link inside a confirm.
 *
 *  - The list is Kratos' settings flow (`passkey_remove` nodes,
 *    `passkeys-model.ts`): when each was added, and Remove. Kratos has no
 *    rename, so there is none.
 *  - Add: with a passkey already, it first confirms with it
 *    (`presence.authorizePasskeyChange`, W3 slice 3): Kratos' guard refuses
 *    a new one without that grant (`passkey-add-model.ts`).
 *  - Remove: a confirm, then the same grant (`change: "remove"`), then the
 *    flow's `passkey_remove`. The person's last passkey while approvals need
 *    them in person is not removable, with the sentence why; the pod refuses
 *    it too (PRESENCE_LAST_PASSKEY) before the proof is spent.
 *
 * A refusal is a fixed sentence by code; a caught error's own text goes
 * behind "Copy details", never as the headline.
 */

import { useCallback, useEffect, useState } from "react";
import { Button, addToast } from "@heroui/react";
import { AlertCircle, KeyRound, Lock } from "lucide-react";
import { PRESENCE_LAST_PASSKEY } from "@synap-core/types/presence";
import { SectionCard } from "../../(admin)/components/section-card";
import { StatusPill } from "../../(admin)/components/status-pill";
import { ConfirmModal } from "../../(admin)/components/confirm-modal";
import {
  collectErrorMessages,
  createBrowserFlow,
  nodeValue,
  submitSelfServiceFlow,
  type KratosFlow,
} from "../../../lib/kratos-flow";
import {
  createPasskey,
  isPasskeySupported,
  PasskeyCancelled,
} from "../../../lib/passkey";
import { formatDate } from "../../../lib/format";
import { trpc } from "../../../lib/trpc";
import { useT } from "../../../lib/i18n/locale-provider";
import { CopyButton, errorDetail } from "../copy-button";
import { PresenceDeclined } from "../presence/presence-model";
import { useAuthorizePasskeyChange } from "../presence/use-factor-doors";
import { usePodSensitivity } from "../presence/use-sensitivity";
import { en, fr } from "./copy";
import { passkeyAddStep } from "./passkey-add-model";
import {
  passkeyRemoveBlock,
  passkeyRows,
  type PasskeyRemoveBlock,
  type PasskeyRow,
} from "./passkeys-model";

const CATALOGS = { en, fr };

type FlowLoad =
  | { kind: "loading" }
  | { kind: "failed"; detail: string }
  | { kind: "ready"; flow: KratosFlow };

const BLOCK_WORD: Record<
  PasskeyRemoveBlock,
  | "passkeys.block.onlySignIn"
  | "passkeys.block.lastWithProof"
  | "passkeys.block.unknownMode"
> = {
  onlySignIn: "passkeys.block.onlySignIn",
  lastWithProof: "passkeys.block.lastWithProof",
  unknownMode: "passkeys.block.unknownMode",
};

/** The pod's last-passkey refusal (`assertMayRemovePasskey`), by its code. */
function isLastPasskeyRefusal(err: unknown): boolean {
  const data = (err as { data?: { reasonCode?: unknown } | null } | null)?.data;
  return data?.reasonCode === PRESENCE_LAST_PASSKEY;
}

export function PasskeysCard({
  returnTo,
}: {
  /** Where sign-in brings the person back (this page, `#passkeys`). */
  returnTo: string;
}) {
  const t = useT(CATALOGS);
  const [load, setLoad] = useState<FlowLoad>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  // A passkey change needs a grant from an existing factor (W3 slice 3).
  const me = trpc.users.me.useQuery(undefined, { staleTime: 300_000 });
  const devices = trpc.presence.devices.list.useQuery(undefined, {
    retry: false,
  });
  // The mode in force: the last passkey stays while it is `enforce` (W5).
  const sensitivity = usePodSensitivity();
  const authorize = useAuthorizePasskeyChange();
  const [grantedUntil, setGrantedUntil] = useState<number | null>(null);
  const [removing, setRemoving] = useState<PasskeyRow | null>(null);
  /** A fixed sentence; a caught error's own text goes behind "Copy details". */
  const [error, setError] = useState<{
    message: string;
    detail?: string;
  } | null>(null);
  const [needsReauth, setNeedsReauth] = useState(false);

  const start = useCallback(async () => {
    setLoad({ kind: "loading" });
    try {
      const r = await createBrowserFlow("settings");
      if ("flow" in r) setLoad({ kind: "ready", flow: r.flow });
      else
        window.location.assign(`/login?return=${encodeURIComponent(returnTo)}`);
    } catch (err) {
      setLoad({ kind: "failed", detail: errorDetail(err) });
    }
  }, [returnTo]);

  useEffect(() => {
    void start();
  }, [start]);

  // Step 1 when the person has a passkey: confirm with it; the pod holds the
  // grant for one change. The new passkey is created on the next press.
  const confirmFirst = async () => {
    const userId = me.data?.id;
    if (!userId) return;
    setBusy(true);
    setError(null);
    try {
      const grant = await authorize(userId, "add");
      setGrantedUntil(Date.now() + grant.expiresInSeconds * 1000);
    } catch (err) {
      if (!(err instanceof PresenceDeclined))
        setError({
          message: t("passkeys.grant.failed"),
          detail: errorDetail(err),
        });
    } finally {
      setBusy(false);
    }
  };

  /** Kratos' answer to a passkey change: the new flow, a sign-in, an error. */
  const settle = (
    r: Awaited<ReturnType<typeof submitSelfServiceFlow>>,
    words: { done: string; failed: string }
  ) => {
    if (r.kind === "refresh_required") setNeedsReauth(true);
    else if (r.kind === "flow") {
      setLoad({ kind: "ready", flow: r.flow });
      const errors = collectErrorMessages(r.flow);
      // Kratos' own messages are its words for the field; shown as detail.
      if (errors.length)
        setError({ message: words.failed, detail: errors.join(" ") });
      else if (r.flow.state === "success")
        addToast({ title: words.done, color: "default" });
    } else if (r.kind === "redirect") window.location.assign(r.to);
    else if (r.kind === "session") void start();
    else setError({ message: words.failed });
  };

  const add = async () => {
    if (load.kind !== "ready") return;
    const flow = load.flow;
    const createData = nodeValue(flow, "passkey_create_data");
    if (!createData) return;
    setBusy(true);
    setError(null);
    setNeedsReauth(false);
    try {
      const register = await createPasskey(createData);
      // The guard redeems the grant whatever happens next: one proof, one try.
      setGrantedUntil(null);
      const r = await submitSelfServiceFlow(flow, {
        method: "passkey",
        csrf_token: nodeValue(flow, "csrf_token") ?? "",
        passkey_settings_register: register,
      });
      settle(r, { done: t("passkeys.added"), failed: t("passkeys.addFailed") });
    } catch (err) {
      if (!(err instanceof PasskeyCancelled)) {
        setError({
          message: t("passkeys.addFailed"),
          detail: errorDetail(err),
        });
      }
    } finally {
      setBusy(false);
    }
  };

  // Remove: the grant first (the person holds a passkey, so Kratos' guard
  // asks for it), then the flow's `passkey_remove`. The confirm closes first:
  // the passkey dialog never opens over it.
  const remove = async (row: PasskeyRow) => {
    setRemoving(null);
    if (load.kind !== "ready") return;
    const userId = me.data?.id;
    if (!userId) return;
    const flow = load.flow;
    setBusy(true);
    setError(null);
    setNeedsReauth(false);
    try {
      await authorize(userId, "remove");
      const r = await submitSelfServiceFlow(flow, {
        method: "passkey",
        csrf_token: nodeValue(flow, "csrf_token") ?? "",
        passkey_remove: row.id,
      });
      settle(r, {
        done: t("passkeys.removed"),
        failed: t("passkeys.removeFailed"),
      });
    } catch (err) {
      if (err instanceof PresenceDeclined) return;
      setError(
        isLastPasskeyRefusal(err)
          ? { message: t("passkeys.block.lastWithProof") }
          : { message: t("passkeys.removeFailed"), detail: errorDetail(err) }
      );
    } finally {
      setBusy(false);
    }
  };

  const rows = load.kind === "ready" ? passkeyRows(load.flow) : [];
  const count = rows.length;
  const step = passkeyAddStep({
    passkeys: count,
    deviceKeys: devices.isError ? null : (devices.data?.length ?? 0),
    granted: grantedUntil !== null && Date.now() < grantedUntil,
  });
  const enabled =
    load.kind === "ready" &&
    nodeValue(load.flow, "passkey_create_data") !== null;
  const canAdd = enabled && isPasskeySupported();
  const reauthHref = `/login?refresh=1&return=${encodeURIComponent(returnTo)}`;

  return (
    <div id="passkeys" className="scroll-mt-6">
      <SectionCard
        title={t("passkeys.title")}
        hint={t("passkeys.hint")}
        actions={
          load.kind === "ready" ? (
            <StatusPill
              kind={count > 0 ? "healthy" : "unknown"}
              label={t("passkeys.count", { n: count })}
            />
          ) : null
        }
      >
        {load.kind === "loading" || devices.isLoading ? (
          <div className="h-12 rounded-medium bg-foreground/[0.05] shimmer-pulse" />
        ) : load.kind === "failed" ? (
          <div className="flex flex-col items-start gap-2">
            <p className="flex items-start gap-2 text-[12.5px] text-status-down">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t("passkeys.loadFailed")}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="flat"
                radius="md"
                onPress={() => void start()}
              >
                {t("passkeys.retry")}
              </Button>
              <CopyButton
                text={load.detail}
                label={t("passkeys.copyDetails")}
                variant="light"
              />
            </div>
          </div>
        ) : !enabled ? (
          <p className="text-[12.5px] text-foreground/65">
            {t("passkeys.disabled")}
          </p>
        ) : (
          <div className="flex flex-col items-start gap-3">
            {needsReauth ? (
              <div
                className="flex flex-col items-start gap-2 rounded-medium bg-warning/10 p-3 text-[13px] text-foreground/80 ring-1 ring-inset ring-warning/30"
                role="status"
              >
                <span className="flex items-start gap-2">
                  <Lock className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  {t("passkeys.reauth")}
                </span>
                <Button
                  as="a"
                  href={reauthHref}
                  size="sm"
                  variant="flat"
                  radius="md"
                >
                  {t("passkeys.reauth.action")}
                </Button>
              </div>
            ) : null}
            {error ? (
              <div className="flex flex-col items-start gap-1">
                <p
                  role="alert"
                  className="flex items-start gap-2 text-[12.5px] text-status-down"
                >
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {error.message}
                </p>
                {error.detail ? (
                  <CopyButton
                    text={error.detail}
                    label={t("passkeys.copyDetails")}
                    variant="light"
                    ariaLabel={t("passkeys.copyDetails.aria")}
                  />
                ) : null}
              </div>
            ) : null}

            {rows.length === 0 ? (
              <p className="text-[12.5px] text-foreground/65">
                {t("passkeys.empty")}
              </p>
            ) : (
              <ul className="flex w-full flex-col divide-y divide-foreground/[0.05]">
                {rows.map((row) => {
                  const block = passkeyRemoveBlock({
                    row,
                    passkeys: count,
                    mode: sensitivity?.mode ?? null,
                  });
                  const added = row.addedAt
                    ? t("passkeys.row.added", { date: formatDate(row.addedAt) })
                    : t("passkeys.row.addedUnknown");
                  return (
                    <li key={row.id} className="flex flex-col gap-1 py-2">
                      <div className="flex items-center gap-3">
                        <KeyRound className="h-3.5 w-3.5 shrink-0 text-foreground/50" />
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-[13px] text-foreground/85">
                            {row.name ?? t("passkeys.row.name")}
                          </span>
                          <span className="text-[12px] text-foreground/55">
                            {added}
                          </span>
                        </div>
                        <Button
                          size="sm"
                          radius="md"
                          variant="light"
                          color="danger"
                          isDisabled={block !== null || busy || !me.data?.id}
                          aria-label={t("passkeys.remove.aria", {
                            date: row.addedAt ? formatDate(row.addedAt) : "—",
                          })}
                          onPress={() => setRemoving(row)}
                        >
                          {t("passkeys.remove")}
                        </Button>
                      </div>
                      {block ? (
                        <p className="pl-6 text-[12px] text-foreground/60">
                          {t(BLOCK_WORD[block])}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}

            {!canAdd ? (
              <p className="text-[12.5px] text-foreground/65">
                {t("passkeys.unsupported")}
              </p>
            ) : step === "devicesFailed" ? (
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-[12.5px] text-status-down">
                  {t("passkeys.devicesFailed")}
                </p>
                <Button
                  size="sm"
                  variant="flat"
                  radius="md"
                  onPress={() => void devices.refetch()}
                >
                  {t("passkeys.retry")}
                </Button>
              </div>
            ) : step === "relayOnly" ? (
              <p className="text-[12.5px] text-foreground/65">
                {t("passkeys.relayOnly")}
              </p>
            ) : step === "create" ? (
              <div className="flex flex-col items-start gap-2">
                <p className="text-[12.5px] text-foreground/65">
                  {t("passkeys.grant.ready")}
                </p>
                <Button
                  size="sm"
                  radius="md"
                  color="primary"
                  startContent={<KeyRound className="h-3.5 w-3.5" />}
                  isLoading={busy}
                  onPress={() => void add()}
                >
                  {t("passkeys.grant.create")}
                </Button>
              </div>
            ) : step === "authorize" ? (
              <div className="flex flex-col items-start gap-2">
                <p className="text-[12.5px] text-foreground/65">
                  {t("passkeys.grant.why")}
                </p>
                <Button
                  size="sm"
                  radius="md"
                  variant="flat"
                  startContent={<KeyRound className="h-3.5 w-3.5" />}
                  isLoading={busy}
                  isDisabled={!me.data?.id}
                  onPress={() => void confirmFirst()}
                >
                  {t("passkeys.add")}
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                radius="md"
                variant="solid"
                color="primary"
                startContent={<KeyRound className="h-3.5 w-3.5" />}
                isLoading={busy}
                onPress={() => void add()}
              >
                {t("passkeys.add")}
              </Button>
            )}
          </div>
        )}
      </SectionCard>

      <ConfirmModal
        isOpen={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) void remove(removing);
        }}
        title={t("passkeys.remove.title")}
        consequence={t("passkeys.remove.consequence")}
        confirmLabel={t("passkeys.remove.confirm")}
        confirmColor="danger"
      />
    </div>
  );
}

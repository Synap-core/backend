"use client";

/**
 * The security nudge — what Home's card and the top bar's ⚠ ask for, from
 * the ONE rule (`securityNudge`, `_lib/presence/ways-in/ways-in-model.ts`;
 * founder, 7 Nov 2026, session 539e519b): under `enforce`, a first or a
 * second way to confirm it's you; otherwise recovery codes (founder decision
 * R3, 2026-10-04). Skippable, with a persistent ⚠ until done.
 *
 *   - `SecurityNudge` — the card on Home. "Skip for now" hides the CARD for
 *     that ask on this browser only.
 *   - `useSecurityNudge` — feeds the top bar's ⚠ mark, which stays until the
 *     ask is met (it is never dismissible).
 *   - `useRecoveryCodesState` — the recovery codes' cached status.
 *
 * A failed read shows nothing here: this is a nudge, not the door. The door
 * (`/settings/security`) shows the failure with a Retry.
 */

import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { ShieldAlert } from "lucide-react";
import { CREATE_RECOVERY_CODES_LABEL } from "@synap-core/types/account-recovery";
import { recoveryApi } from "../../../lib/account-recovery";
import { useT } from "../../../lib/i18n/locale-provider";
import { en, fr } from "../../_lib/presence/ways-in/copy";
import { useWaysIn } from "../../_lib/presence/ways-in/use-ways-in";
import {
  securityNudge,
  type RecoveryCodesState,
  type SecurityNudge as SecurityNudgeKind,
} from "../../_lib/presence/ways-in/ways-in-model";

export type { RecoveryCodesState } from "../../_lib/presence/ways-in/ways-in-model";

const CATALOGS = { en, fr };

/** Per ask: skipping the codes card does not hide a later "second way" one. */
const skipKey = (kind: NonNullable<SecurityNudgeKind>) =>
  kind === "codes"
    ? "pod-admin.recovery-codes-nudge.skipped"
    : `pod-admin.security-nudge.${kind}.skipped`;

/**
 * The shared status read behind the card and the top bar's mark.
 *
 * One read per page load — but a SUCCESSFUL read only: a failed read
 * ("unknown") is never cached, so the next mount tries again. And creating
 * codes (`/settings/security`) calls {@link invalidateRecoveryCodesState}, so
 * the ⚠ does not outlive the codes on client navigation. Mounted hooks are
 * told to re-read.
 */
export function createRecoveryCodesStateCache(
  readStatus: () => Promise<{
    ok: boolean;
    data?: { recoveryCodes: { set: boolean } };
  }>
) {
  let pending: Promise<RecoveryCodesState> | null = null;
  const listeners = new Set<() => void>();
  return {
    read(): Promise<RecoveryCodesState> {
      if (pending) return pending;
      const p: Promise<RecoveryCodesState> = readStatus()
        .then((r) =>
          r.ok && r.data
            ? r.data.recoveryCodes.set
              ? "set"
              : "not_set"
            : "unknown"
        )
        .catch(() => "unknown" as const)
        .then((state) => {
          if (state === "unknown" && pending === p) pending = null;
          return state;
        });
      pending = p;
      return p;
    },
    invalidate(): void {
      pending = null;
      for (const l of listeners) l();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const cache = createRecoveryCodesStateCache(() => recoveryApi.status());

/** Call after codes were created (or replaced): the next read goes to the pod. */
export const invalidateRecoveryCodesState = (): void => cache.invalidate();

export function useRecoveryCodesState(): RecoveryCodesState {
  const [state, setState] = useState<RecoveryCodesState>("unknown");
  useEffect(() => {
    let live = true;
    const load = () => void cache.read().then((s) => live && setState(s));
    load();
    const off = cache.subscribe(load);
    return () => {
      live = false;
      off();
    };
  }, []);
  return state;
}

/** What the top bar's ⚠ and Home's card ask for right now, or null. */
export function useSecurityNudge(): SecurityNudgeKind {
  const codes = useRecoveryCodesState();
  const { state } = useWaysIn();
  return securityNudge(state, codes);
}

function skipped(kind: NonNullable<SecurityNudgeKind>): boolean {
  try {
    return window.localStorage.getItem(skipKey(kind)) === "1";
  } catch {
    return false;
  }
}

export function SecurityNudge() {
  const t = useT(CATALOGS);
  const kind = useSecurityNudge();
  // Hidden until mounted: localStorage is a browser read.
  const [mounted, setMounted] = useState(false);
  const [skippedNow, setSkippedNow] = useState<string[]>([]);
  useEffect(() => setMounted(true), []);

  if (!mounted || !kind || skippedNow.includes(kind) || skipped(kind)) {
    return null;
  }

  return (
    <div
      className="mb-5 flex flex-col gap-3 rounded-large bg-warning/10 p-4 ring-1 ring-inset ring-warning/30 sm:flex-row sm:items-center"
      role="status"
    >
      <ShieldAlert className="h-5 w-5 shrink-0 text-warning" strokeWidth={2} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-[13.5px] font-medium text-foreground">
          {t(`nudge.${kind}.title`)}
        </p>
        <p className="text-[12.5px] text-foreground/65">
          {t(`nudge.${kind}.line`)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="light"
          size="sm"
          radius="md"
          onPress={() => {
            try {
              window.localStorage.setItem(skipKey(kind), "1");
            } catch {
              /* private window: the card just comes back next visit */
            }
            setSkippedNow([...skippedNow, kind]);
          }}
        >
          {t("nudge.skip")}
        </Button>
        <Button
          as="a"
          href={
            kind === "codes"
              ? "/settings/security#recovery-codes"
              : "/settings/security#ways-in"
          }
          color="primary"
          size="sm"
          radius="md"
        >
          {kind === "codes" ? CREATE_RECOVERY_CODES_LABEL : t("nudge.open")}
        </Button>
      </div>
    </div>
  );
}

"use client";

/**
 * "Save your recovery codes" — founder decision R3 (2026-10-04): skippable,
 * with a persistent ⚠ until saved.
 *
 *   - `RecoveryCodesNudge` — the card on Overview after sign-in. "Skip for now"
 *     hides the CARD on this browser only.
 *   - `useRecoveryCodesState` — feeds the top bar's ⚠ mark, which stays until
 *     codes exist (it is never dismissible).
 *
 * A failed status read shows nothing here: this is a nudge, not the door. The
 * door (`/settings/security`) shows the failure with a Retry.
 */

import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { ShieldAlert } from "lucide-react";
import { recoveryApi } from "../../../lib/account-recovery";

export type RecoveryCodesState = "unknown" | "set" | "not_set";

const SKIP_KEY = "pod-admin.recovery-codes-nudge.skipped";

let pending: Promise<RecoveryCodesState> | null = null;

/** One status read per page load, shared by the card and the top bar. */
function readState(): Promise<RecoveryCodesState> {
  pending ??= recoveryApi.status().then((r) =>
    r.ok ? (r.data.recoveryCodes.set ? "set" : "not_set") : "unknown"
  );
  return pending;
}

export function useRecoveryCodesState(): RecoveryCodesState {
  const [state, setState] = useState<RecoveryCodesState>("unknown");
  useEffect(() => {
    let live = true;
    void readState().then((s) => live && setState(s));
    return () => {
      live = false;
    };
  }, []);
  return state;
}

function skipped(): boolean {
  try {
    return window.localStorage.getItem(SKIP_KEY) === "1";
  } catch {
    return false;
  }
}

export function RecoveryCodesNudge() {
  const state = useRecoveryCodesState();
  const [hidden, setHidden] = useState(true);
  useEffect(() => setHidden(skipped()), []);

  if (state !== "not_set" || hidden) return null;

  return (
    <div
      className="mb-5 flex flex-col gap-3 rounded-large bg-warning/10 p-4 ring-1 ring-inset ring-warning/30 sm:flex-row sm:items-center"
      role="status"
    >
      <ShieldAlert className="h-5 w-5 shrink-0 text-warning" strokeWidth={2} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-[13.5px] font-medium text-foreground">
          Save your recovery codes
        </p>
        <p className="text-[12.5px] text-foreground/65">
          If you lose your password and Synap Cloud, they are the only way back
          in without the server.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="light"
          size="sm"
          radius="md"
          onPress={() => {
            try {
              window.localStorage.setItem(SKIP_KEY, "1");
            } catch {
              /* private window: the card just comes back next visit */
            }
            setHidden(true);
          }}
        >
          Skip for now
        </Button>
        <Button
          as="a"
          href="/settings/security#recovery-codes"
          color="primary"
          size="sm"
          radius="md"
        >
          Create codes
        </Button>
      </div>
    </div>
  );
}

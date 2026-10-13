"use client";

/**
 * The pod default lifetime of a COMPUTER's key (MACHINE-IDENTITY-PLAN,
 * founder decision 4) — the Computers page's header action. A computer
 * connected with `synap init`, and the agents it sets up, get keys that last
 * this many days; the terminal renews them before they run out. A computer
 * can override it (its own page, "Change key lifetime").
 *
 * Reads/writes `apiKeys.getMachineDefaults` / `.setMachineDefaults` (pod
 * admin) through `/api/machine-defaults`. A failed read says so with Retry —
 * never a guessed "90".
 */

import { Button, Input, addToast } from "@heroui/react";
import { useCallback, useEffect, useState } from "react";
import { trpc } from "../../../../lib/trpc";
import type { MachineDefaults } from "../../../../lib/machine-defaults";
import { days } from "./computer-model";
import { FormModal } from "./computer-modals";

type Read =
  | { state: "loading" }
  | { state: "ok"; value: MachineDefaults }
  | { state: "failed"; message: string };

async function call(init?: RequestInit): Promise<MachineDefaults> {
  const res = await fetch("/api/machine-defaults", {
    cache: "no-store",
    ...init,
  });
  const body = (await res.json().catch(() => ({}))) as MachineDefaults & {
    error?: string;
  };
  if (!res.ok) throw new Error(body.error ?? `Error (${res.status})`);
  return body;
}

/** The pod default, read once per mount, with a retry. */
export function usePodKeyDefaults() {
  const [read, setRead] = useState<Read>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setRead({ state: "loading" });
    call()
      .then((value) => {
        if (live) setRead({ state: "ok", value });
      })
      .catch((err) => {
        if (live)
          setRead({
            state: "failed",
            message: err instanceof Error ? err.message : "Couldn't read",
          });
      });
    return () => {
      live = false;
    };
  }, [attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { read, setRead, retry };
}

export function PodKeyLifetimeAction({
  defaults,
}: {
  defaults: ReturnType<typeof usePodKeyDefaults>;
}) {
  const { read, setRead, retry } = defaults;
  const [editing, setEditing] = useState(false);

  if (read.state === "loading")
    return (
      <span
        aria-label="Reading the key lifetime"
        className="inline-block h-5 w-44 rounded bg-foreground/[0.07] shimmer-pulse"
      />
    );
  if (read.state === "failed")
    return (
      <span className="flex items-center gap-2 text-[12.5px] text-status-down">
        Couldn&apos;t read the key lifetime.
        <Button size="sm" variant="flat" radius="md" onPress={retry}>
          Retry
        </Button>
      </span>
    );

  const v = read.value;
  return (
    <>
      <span className="flex flex-wrap items-center gap-2 text-[12.5px] text-foreground/65">
        <span>
          Key lifetime:{" "}
          <span className="font-medium text-foreground">
            {days(v.keyTtlDays)}
          </span>{" "}
          (pod default)
        </span>
        <Button
          size="sm"
          variant="flat"
          radius="md"
          onPress={() => setEditing(true)}
        >
          Change
        </Button>
      </span>
      {editing && (
        <PodKeyLifetimeModal
          value={v}
          onSaved={(value) => setRead({ state: "ok", value })}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}

function PodKeyLifetimeModal({
  value,
  onSaved,
  onClose,
}: {
  value: MachineDefaults;
  onSaved: (value: MachineDefaults) => void;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState(String(value.keyTtlDays));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = Number(draft);
  const valid =
    Number.isInteger(n) && n >= value.minKeyTtlDays && n <= value.maxKeyTtlDays;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await call({
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyTtlDays: n }),
      });
      onSaved(saved);
      // Every computer that follows the default now reads the new lifetime.
      await utils.machines.invalidate();
      addToast({
        title: "Saved",
        description: `New computer keys last ${days(saved.keyTtlDays)}.`,
        color: "default",
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormModal
      title="Computer key lifetime"
      submitLabel="Save"
      isPending={saving}
      canSubmit={valid && n !== value.keyTtlDays}
      error={error}
      onClose={onClose}
      onSubmit={() => void save()}
    >
      <p className="text-[12.5px] leading-relaxed text-foreground/65">
        How long a connected computer&apos;s key — and its agents&apos; — lasts.
        The terminal renews it before then. Applies to keys made from now on; a
        computer with its own lifetime keeps it.
      </p>
      <Input
        autoFocus
        type="number"
        size="sm"
        label="Days"
        className="max-w-40"
        min={value.minKeyTtlDays}
        max={value.maxKeyTtlDays}
        value={draft}
        onValueChange={setDraft}
        isInvalid={!valid}
        errorMessage={`${value.minKeyTtlDays}–${value.maxKeyTtlDays} days`}
        description={
          value.stored
            ? `${value.minKeyTtlDays}–${value.maxKeyTtlDays} days`
            : `Built-in default: ${days(value.defaultKeyTtlDays)}.`
        }
      />
    </FormModal>
  );
}

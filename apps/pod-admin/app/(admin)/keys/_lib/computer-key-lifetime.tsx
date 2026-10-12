"use client";

/**
 * Trust & Keys → API keys: the pod default lifetime of a COMPUTER's key
 * (MACHINE-IDENTITY-PLAN, founder decision 4). A computer connected with
 * `synap init`, and the agents it sets up, get keys that last this many days;
 * the terminal renews them before they run out. A computer can override it.
 *
 * Reads/writes `apiKeys.getMachineDefaults` / `.setMachineDefaults` through
 * `/api/machine-defaults` (the procedures are newer than the typed client).
 * A failed read is an error with Retry — never a guessed "90".
 */

import { Button, Input, addToast } from "@heroui/react";
import { useEffect, useState } from "react";
import {
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { SectionCard } from "../../components/section-card";
import type { MachineDefaults } from "../../../../lib/machine-defaults";

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

export function ComputerKeyLifetime() {
  const [read, setRead] = useState<Read>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    setRead({ state: "loading" });
    call()
      .then((value) => {
        if (!live) return;
        setRead({ state: "ok", value });
        setDraft(String(value.keyTtlDays));
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

  const days = Number(draft);
  const v = read.state === "ok" ? read.value : null;
  const valid =
    v !== null &&
    Number.isInteger(days) &&
    days >= v.minKeyTtlDays &&
    days <= v.maxKeyTtlDays;
  const changed = v !== null && days !== v.keyTtlDays;

  const save = async () => {
    setSaving(true);
    try {
      const value = await call({
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyTtlDays: days }),
      });
      setRead({ state: "ok", value });
      setDraft(String(value.keyTtlDays));
      addToast({
        title: "Saved",
        description: `New computer keys last ${value.keyTtlDays} days.`,
        color: "success",
      });
    } catch (err) {
      addToast({
        title: "Couldn't save",
        description:
          err instanceof Error ? err.message : "Something went wrong",
        color: "danger",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title="Computer keys"
      hint="How long a connected computer's key lasts. Your terminal renews it before then."
    >
      {read.state === "loading" && <ResourceRowSkeleton />}
      {read.state === "failed" && (
        <ResourceRowError
          message={`Couldn't read the computer key lifetime: ${read.message}`}
          onRetry={() => setAttempt((n) => n + 1)}
        />
      )}
      {v && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && changed) void save();
          }}
        >
          <Input
            type="number"
            size="sm"
            label="Days"
            className="w-32"
            min={v.minKeyTtlDays}
            max={v.maxKeyTtlDays}
            value={draft}
            onValueChange={setDraft}
            isInvalid={!valid}
            errorMessage={`${v.minKeyTtlDays}–${v.maxKeyTtlDays} days`}
          />
          <Button
            type="submit"
            size="sm"
            color="primary"
            isDisabled={!valid || !changed}
            isLoading={saving}
          >
            Save
          </Button>
          {!v.stored && (
            <p className="basis-full text-tiny text-foreground/55">
              Default: {v.defaultKeyTtlDays} days. Applies to keys made from now
              on.
            </p>
          )}
        </form>
      )}
    </SectionCard>
  );
}

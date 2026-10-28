"use client";

/**
 * S1 — "What should Synap run first?" (plan v1 §1 S1; canvas S1).
 *
 * The start cards come from the pod's bundled templates (`meta.start`), so a
 * self-hosted pod lists them offline. On cloud the synap.live pick is
 * pre-selected and carries a "From synap.live" mark; a FAILED cloud read is
 * shown as a warning and pre-selects nothing, but never blocks the step.
 *
 * Continue records the intent (`onboarding.recordStartStep`) and reopens
 * `/start`, which sends the person to the step the pod says is next. "Skip
 * setup for now" dismisses the journey and lands on Home.
 */

import { Button, Chip } from "@heroui/react";
import {
  AlertTriangle,
  Briefcase,
  ExternalLink,
  Handshake,
  Layers,
  Package,
  PenTool,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { navHref } from "../../lib/console-nav";
import { intentPatch, type IntentModel } from "./_lib/start-model";

/** The templates' `meta.icon` lucide names; anything else draws a neutral glyph. */
const START_ICONS: Record<string, LucideIcon> = {
  briefcase: Briefcase,
  handshake: Handshake,
  "pen-tool": PenTool,
  wrench: Wrench,
};

type Pending = "continue" | "skip" | null;

async function postStart(body: unknown): Promise<string | null> {
  try {
    const res = await fetch("/api/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return null;
    const payload = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    return payload?.error ?? `The pod answered ${res.status}.`;
  } catch {
    return "Could not reach this pod.";
  }
}

export function StartIntentForm({ model }: { model: IntentModel }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(model.selected);
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (kind: Exclude<Pending, null>) => {
    setPending(kind);
    setError(null);
    const failure =
      kind === "continue" && selected
        ? await postStart({
            action: "intent",
            ...intentPatch(selected, model),
          })
        : await postStart({ action: "skip" });
    if (failure) {
      setError(failure);
      setPending(null);
      return;
    }
    router.push(kind === "continue" ? "/start" : navHref("home"));
  };

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <h1 className="font-heading text-[22px] font-semibold leading-tight tracking-tight text-foreground">
          What should Synap run first?
        </h1>
        <p className="text-[13.5px] text-foreground/70">
          Pick one. Synap prepares its space, and you approve it before anything
          is created.
        </p>
      </div>

      {model.cloudFailed && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-lg bg-warning/10 px-3 py-2 text-[13px] text-warning ring-1 ring-inset ring-warning/30"
        >
          <AlertTriangle aria-hidden className="h-4 w-4 shrink-0" />
          <span className="flex-1">
            Couldn&apos;t read your answer from synap.live.
          </span>
          <Button size="sm" variant="light" onPress={() => router.refresh()}>
            Try again
          </Button>
        </div>
      )}

      {model.cards.length === 0 ? (
        <StartsEmpty />
      ) : (
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Start</legend>
          {model.cards.map((card) => {
            const Icon = START_ICONS[card.icon] ?? Layers;
            const checked = selected === card.slug;
            return (
              <label
                key={card.slug}
                className={`flex cursor-pointer items-start gap-3 rounded-lg p-3 ring-1 ring-inset transition-colors ${
                  checked
                    ? "bg-primary/10 ring-primary/60"
                    : "bg-content1 ring-foreground/10 hover:bg-foreground/[0.04]"
                }`}
              >
                <input
                  type="radio"
                  name="start"
                  value={card.slug}
                  checked={checked}
                  onChange={() => setSelected(card.slug)}
                  className="peer sr-only"
                />
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-foreground/[0.06] text-foreground/80">
                  <Icon aria-hidden className="h-4 w-4" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-foreground">
                    {card.label}
                    {model.fromCloud === card.slug && (
                      <Chip
                        size="sm"
                        radius="sm"
                        variant="flat"
                        color="secondary"
                        startContent={
                          <ExternalLink aria-hidden className="h-3 w-3" />
                        }
                      >
                        From synap.live
                      </Chip>
                    )}
                  </span>
                  <span className="text-[12.5px] text-foreground/70">
                    {card.promise}
                  </span>
                </span>
                <span
                  aria-hidden
                  className={`mt-1 h-4 w-4 shrink-0 rounded-full ring-1 ring-inset peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus ${
                    checked
                      ? "bg-primary ring-primary shadow-[inset_0_0_0_3px_hsl(var(--heroui-content1))]"
                      : "ring-foreground/30"
                  }`}
                />
              </label>
            );
          })}
        </fieldset>
      )}

      {model.said && (
        <p className="text-[13px] text-foreground/75">
          <b className="font-medium text-foreground">You said:</b> &quot;
          {model.said}&quot;
        </p>
      )}

      {error && (
        <p role="alert" className="text-[12.5px] text-status-down">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {model.cards.length > 0 && (
          <Button
            color="primary"
            radius="md"
            isDisabled={!selected || pending !== null}
            isLoading={pending === "continue"}
            onPress={() => run("continue")}
          >
            Continue
          </Button>
        )}
        <Button
          variant="light"
          radius="md"
          isDisabled={pending !== null}
          isLoading={pending === "skip"}
          onPress={() => run("skip")}
        >
          Skip setup for now
        </Button>
      </div>
    </>
  );
}

/** EXPLAIN: an older pod whose bundled catalog declares no start. */
function StartsEmpty() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg bg-foreground/[0.03] px-4 py-6 text-center ring-1 ring-inset ring-foreground/10">
      <Package aria-hidden className="h-5 w-5 text-foreground/65" />
      <h2 className="text-[14px] font-medium text-foreground">
        No starting points yet
      </h2>
      <p className="text-[12.5px] text-foreground/70">
        This pod has no starting points yet. Update the pod, or pick a template
        in Marketplace.
      </p>
      <Button
        as={Link}
        href={navHref("marketplace")}
        size="sm"
        variant="flat"
        radius="md"
      >
        Open Marketplace
      </Button>
    </div>
  );
}

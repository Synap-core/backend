"use client";

/**
 * Updates — which version this pod runs and how it updates.
 *
 *   • Release        — the release the last record proves, and what the last
 *                      update did (applied / rolled back / failed) with its
 *                      recorded reason in plain words.
 *   • Auto-update    — the switch and the channel (shown here only, once),
 *                      both stored on the POD
 *                      (`/api/pod-updates`). Editable only by a pod admin
 *                      (`canEdit`); the pod re-checks on every write.
 *   • Update now     — the exact host command. The console cannot run host
 *                      commands (the engine runs on the machine hosting the
 *                      pod), so it says so and offers the command to copy.
 *
 * A failed read is an error with Retry, never the default setting shown as the
 * owner's choice; a 404 is an older pod that cannot do this yet.
 */

import { Radio, RadioGroup, Switch, addToast } from "@heroui/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { CommandLine } from "../../_lib/command-line";
import { formatRelative, formatTimestamp } from "../../../lib/format";
import { PageHeader, PageShell } from "../components/page-header";
import {
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../components/resource-row";
import { SectionCard } from "../components/section-card";
import { StatusPill } from "../components/status-pill";
import {
  currentRelease,
  outcomeView,
  UPDATE_CHANNELS,
  updateCommand,
  type PodUpdatesView,
  type UpdateChannel,
  type UpdateSettings,
} from "./_lib/updates-model";
import {
  POD_UPDATES_KEY,
  PodUpdatesError,
  readPodUpdatesResponse,
  usePodUpdates,
} from "./_lib/use-pod-updates";

export default function UpdatesPage() {
  const q = usePodUpdates();

  return (
    <PageShell>
      <PageHeader
        title="Updates"
        description="Which version your pod runs and how it updates."
      />
      {q.isLoading ? (
        // The three cards the page lands with, so nothing jumps on arrival.
        <div className="flex flex-col gap-4" aria-busy="true">
          {["Release", "Auto-update", "How to update now"].map((title) => (
            <SectionCard key={title} title={title}>
              <ResourceRowSkeleton count={title === "Release" ? 2 : 1} />
            </SectionCard>
          ))}
        </div>
      ) : q.isError || !q.data ? (
        <SectionCard title="Release">
          {q.error instanceof PodUpdatesError && q.error.status === 404 ? (
            <ResourceRowEmpty message="This pod manages updates in a newer version. Update it once from the machine hosting it, then come back." />
          ) : (
            <ResourceRowError
              message="Couldn't read this pod's update status."
              onRetry={() => void q.refetch()}
            />
          )}
        </SectionCard>
      ) : (
        <div className="flex flex-col gap-4">
          <ReleaseCard view={q.data} />
          <AutoUpdateCard view={q.data} />
          <UpdateNowCard channel={q.data.settings.channel} />
        </div>
      )}
    </PageShell>
  );
}

// ─── Release ────────────────────────────────────────────────────────

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="shrink-0 text-[12px] text-foreground/65 sm:w-36">
        {label}
      </dt>
      <dd className="min-w-0 break-words text-[12.5px] text-foreground">
        {value}
      </dd>
    </div>
  );
}

function ReleaseCard({ view }: { view: PodUpdatesView }) {
  const { lastUpdate } = view;
  const release = currentRelease(lastUpdate);
  const outcome =
    lastUpdate.kind === "recorded" ? outcomeView(lastUpdate.outcome) : null;
  const when = lastUpdate.kind === "recorded" ? lastUpdate.outcome.at : null;

  return (
    <SectionCard title="Release" hint="What this pod runs, and the last update">
      <div className="flex flex-col gap-4">
        <dl className="flex flex-col gap-2">
          <Fact
            label="Current release"
            value={
              release ? (
                <span className="font-mono">{release}</span>
              ) : (
                "Not recorded"
              )
            }
          />
          {when && (
            <Fact
              label="Last update"
              value={`${formatTimestamp(when)} (${formatRelative(when)})`}
            />
          )}
        </dl>

        {outcome ? (
          <div className="flex flex-wrap items-start gap-3">
            <StatusPill kind={outcome.kind} label={outcome.label} />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="text-[13px] text-foreground">{outcome.sentence}</p>
              {outcome.reason && (
                <p className="text-[12.5px] text-foreground/65">
                  Why: {outcome.reason}
                </p>
              )}
            </div>
          </div>
        ) : (
          <p className="text-[12.5px] text-foreground/65">
            {lastUpdate.kind === "unreadable"
              ? "The record of the last update couldn't be read."
              : "No update has run on this pod yet."}
          </p>
        )}
      </div>
    </SectionCard>
  );
}

// ─── Auto-update ────────────────────────────────────────────────────

function AutoUpdateCard({ view }: { view: PodUpdatesView }) {
  const queryClient = useQueryClient();
  const { settings, canEdit } = view;

  const save = useMutation({
    mutationFn: async (patch: Partial<UpdateSettings>) => {
      const res = await fetch("/api/pod-updates/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      return readPodUpdatesResponse(res);
    },
    // The pod answers with the full view, so the saved setting is what it
    // stored — not what this page hoped it stored.
    onSuccess: (next) => queryClient.setQueryData(POD_UPDATES_KEY, next),
    onError: (err) =>
      addToast({
        title: "Couldn't save",
        description:
          err instanceof PodUpdatesError && err.status === 403
            ? "Only a pod admin can change this."
            : "The setting wasn't changed. Try again.",
        color: "danger",
      }),
  });

  const locked = !canEdit || save.isPending;
  const consequence = UPDATE_CHANNELS.find(
    (c) => c.id === settings.channel
  )?.consequence;

  return (
    <SectionCard
      title="Auto-update"
      hint="Whether the pod installs new releases by itself"
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[13px] text-foreground">
              Install updates automatically
            </span>
            <span className="text-[12.5px] text-foreground/65">
              {settings.auto
                ? "New releases on your channel are installed as they come."
                : "Nothing is installed until you update by hand."}
            </span>
          </div>
          <Switch
            size="sm"
            isSelected={settings.auto}
            isDisabled={locked}
            onValueChange={(auto) => save.mutate({ auto })}
            aria-label="Install updates automatically"
          />
        </div>

        <RadioGroup
          label="Channel"
          size="sm"
          value={settings.channel}
          isDisabled={locked}
          onValueChange={(channel) =>
            save.mutate({ channel: channel as UpdateChannel })
          }
          classNames={{ label: "text-[12px] text-foreground/65" }}
        >
          {UPDATE_CHANNELS.map((c) => (
            <Radio key={c.id} value={c.id} description={c.description}>
              {c.label}
            </Radio>
          ))}
        </RadioGroup>
        {consequence && (
          <p className="text-[12.5px] text-foreground/65">{consequence}</p>
        )}
        {!canEdit && (
          <p className="text-[12.5px] text-foreground/65">
            Only a pod admin can change these.
          </p>
        )}
      </div>
    </SectionCard>
  );
}

// ─── Update now ─────────────────────────────────────────────────────

function UpdateNowCard({ channel }: { channel: UpdateChannel }) {
  const command = updateCommand(channel);
  return (
    <SectionCard
      title="How to update now"
      hint="Run this on the machine that hosts your pod"
    >
      <div className="flex flex-col gap-3">
        <p className="text-[12.5px] text-foreground/65">
          This console can&apos;t run commands on the host, so updating by hand
          happens in a terminal there.
        </p>
        <CommandLine command={command} />
      </div>
    </SectionCard>
  );
}

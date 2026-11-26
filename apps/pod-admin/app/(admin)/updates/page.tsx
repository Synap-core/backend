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
 *   • Renderers      — Synap's renderers and their updates
 *                      (`_lib/renderers-card.tsx`). Its own read: it shows
 *                      even when the update status cannot.
 *
 * Words: `_lib/copy.ts` (English source, French draft).
 *
 * A failed read is an error with Retry, never the default setting shown as the
 * owner's choice; a 404 is an older pod that cannot do this yet.
 */

import { Radio, RadioGroup, Switch, addToast } from "@heroui/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { CommandLine } from "../../_lib/command-line";
import { formatRelative, formatTimestamp } from "../../../lib/format";
import { navLabel } from "../../../lib/console-nav";
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
import {
  AUTO_UPDATE_ANCHOR,
  RenderersCard,
  UPDATE_NOW_ANCHOR,
} from "./_lib/renderers-card";
import { en, fr } from "./_lib/copy";
import { useT } from "../../../lib/i18n/locale-provider";

const CATALOGS = { en, fr };

export default function UpdatesPage() {
  const t = useT(CATALOGS);
  const q = usePodUpdates();

  return (
    <PageShell>
      <PageHeader
        title={navLabel("updates")}
        description={t("page.description")}
      />
      {q.isLoading ? (
        // The three cards the page lands with, so nothing jumps on arrival.
        <div className="flex flex-col gap-4" aria-busy="true">
          {(["release.title", "auto.title", "now.title"] as const).map(
            (key) => (
              <SectionCard key={key} title={t(key)}>
                <ResourceRowSkeleton count={key === "release.title" ? 2 : 1} />
              </SectionCard>
            )
          )}
        </div>
      ) : q.isError || !q.data ? (
        <SectionCard title={t("release.title")}>
          {q.error instanceof PodUpdatesError && q.error.status === 404 ? (
            <ResourceRowEmpty message={t("release.older")} />
          ) : (
            <ResourceRowError
              message={t("release.failed")}
              onRetry={() => void q.refetch()}
            />
          )}
        </SectionCard>
      ) : (
        <div className="flex flex-col gap-4">
          <ReleaseCard view={q.data} />
          <div id={AUTO_UPDATE_ANCHOR} className="scroll-mt-4">
            <AutoUpdateCard view={q.data} />
          </div>
          <div id={UPDATE_NOW_ANCHOR} className="scroll-mt-4">
            <UpdateNowCard channel={q.data.settings.channel} />
          </div>
        </div>
      )}
      <div className="mt-4">
        <RenderersCard />
      </div>
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
  const t = useT(CATALOGS);
  const { lastUpdate } = view;
  const release = currentRelease(lastUpdate);
  const outcome =
    lastUpdate.kind === "recorded" ? outcomeView(lastUpdate.outcome) : null;
  const when = lastUpdate.kind === "recorded" ? lastUpdate.outcome.at : null;

  return (
    <SectionCard title={t("release.title")} hint={t("release.hint")}>
      <div className="flex flex-col gap-4">
        <dl className="flex flex-col gap-2">
          <Fact
            label={t("release.current")}
            value={
              release ? (
                <span className="font-mono">{release}</span>
              ) : (
                t("release.notRecorded")
              )
            }
          />
          {when && (
            <Fact
              label={t("release.last")}
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
                  {t("release.why", { reason: outcome.reason })}
                </p>
              )}
            </div>
          </div>
        ) : (
          <p className="text-[12.5px] text-foreground/65">
            {lastUpdate.kind === "unreadable"
              ? t("release.unreadable")
              : t("release.none")}
          </p>
        )}
      </div>
    </SectionCard>
  );
}

// ─── Auto-update ────────────────────────────────────────────────────

function AutoUpdateCard({ view }: { view: PodUpdatesView }) {
  const t = useT(CATALOGS);
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
        title: t("auto.save.failed"),
        description:
          err instanceof PodUpdatesError && err.status === 403
            ? t("auto.save.forbidden")
            : t("auto.save.retry"),
        color: "danger",
      }),
  });

  const locked = !canEdit || save.isPending;
  const consequence = UPDATE_CHANNELS.find(
    (c) => c.id === settings.channel
  )?.consequence;

  return (
    <SectionCard title={t("auto.title")} hint={t("auto.hint")}>
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[13px] text-foreground">
              {t("auto.switch")}
            </span>
            <span className="text-[12.5px] text-foreground/65">
              {settings.auto ? t("auto.on") : t("auto.off")}
            </span>
          </div>
          <Switch
            size="sm"
            isSelected={settings.auto}
            isDisabled={locked}
            onValueChange={(auto) => save.mutate({ auto })}
            aria-label={t("auto.switch")}
          />
        </div>

        <RadioGroup
          label={t("auto.channel")}
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
            {t("auto.adminOnly")}
          </p>
        )}
      </div>
    </SectionCard>
  );
}

// ─── Update now ─────────────────────────────────────────────────────

function UpdateNowCard({ channel }: { channel: UpdateChannel }) {
  const t = useT(CATALOGS);
  const command = updateCommand(channel);
  return (
    <SectionCard title={t("now.title")} hint={t("now.hint")}>
      <div className="flex flex-col gap-3">
        <p className="text-[12.5px] text-foreground/65">{t("now.body")}</p>
        <CommandLine command={command} />
      </div>
    </SectionCard>
  );
}

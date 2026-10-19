"use client";

/**
 * Pod-wide proactive AI defaults. Part of `/intelligence` (`page.tsx`).
 */

import {
  addToast,
  Button,
  Select,
  SelectItem,
  Spinner,
  Switch,
} from "@heroui/react";
import { useEffect, useMemo, useState } from "react";
import { trpc } from "../../../../lib/trpc";
import { readableError } from "../../../../lib/format";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { SectionCard } from "../../components/section-card";
import { ErrorBanner } from "./error-banner";

/**
 * Pod-wide defaults applied to new workspaces (overridable in Studio).
 * Backed by `trpc.proactive.getPodDefaults` / `proactive.setPodDefaults`.
 * Edits are debounced via an explicit Save button so toggles don't fire
 * a mutation on every interaction.
 */

type ProactiveDraft = {
  enabled: boolean;
  nudgeDensity: "low" | "medium" | "high";
  schedules: {
    morningBriefing: boolean;
    weeklyDigest: boolean;
    healthCheck: boolean;
  };
};

export function ProactiveDefaultsSection() {
  const utils = trpc.useUtils();
  const query = trpc.proactive.getPodDefaults.useQuery(undefined, {
    staleTime: 60_000,
  });

  useEffect(() => {
    if (query.isError) {
      redirectToLoginIfUnauthorized(query.error);
    }
  }, [query.isError, query.error]);
  const isAuthRedirecting = query.error?.data?.code === "UNAUTHORIZED";

  const [draft, setDraft] = useState<ProactiveDraft | null>(null);

  // Seed local draft from server data on first load — afterwards local
  // edits stay local until Save / Reset.
  if (draft === null && query.data) {
    setDraft(query.data.defaults);
  }

  const setMutation = trpc.proactive.setPodDefaults.useMutation({
    onSuccess: () => {
      void utils.proactive.getPodDefaults.invalidate();
      addToast({
        title: "Defaults saved",
        description: "Pod-wide proactive defaults updated.",
        color: "default",
      });
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        title: "Couldn't save the proactive defaults",
        description: readableError(err.message),
        color: "danger",
      });
    },
  });

  const dirty = useMemo(() => {
    if (!draft || !query.data) return false;
    const a = draft;
    const b = query.data.defaults;
    return (
      a.enabled !== b.enabled ||
      a.nudgeDensity !== b.nudgeDensity ||
      a.schedules.morningBriefing !== b.schedules.morningBriefing ||
      a.schedules.weeklyDigest !== b.schedules.weeklyDigest ||
      a.schedules.healthCheck !== b.schedules.healthCheck
    );
  }, [draft, query.data]);

  function updateDraft(patch: Partial<ProactiveDraft>) {
    setDraft((d) => (d ? { ...d, ...patch } : d));
  }

  function updateSchedule(key: keyof ProactiveDraft["schedules"], v: boolean) {
    setDraft((d) =>
      d ? { ...d, schedules: { ...d.schedules, [key]: v } } : d
    );
  }

  return (
    <SectionCard
      title="Proactive AI defaults"
      hint="Apply to new spaces — overridable in the app"
      actions={
        dirty && draft ? (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="light"
              radius="md"
              isDisabled={setMutation.isPending}
              onPress={() => query.data && setDraft(query.data.defaults)}
            >
              Reset
            </Button>
            <Button
              size="sm"
              color="primary"
              radius="md"
              isLoading={setMutation.isPending}
              onPress={() => setMutation.mutate(draft)}
            >
              Save
            </Button>
          </div>
        ) : null
      }
    >
      {query.isLoading || isAuthRedirecting || !draft ? (
        <div className="flex items-center gap-2 px-3 py-4 text-[12.5px] text-foreground/65">
          <Spinner size="sm" /> Loading proactive defaults…
        </div>
      ) : query.isError ? (
        <ErrorBanner message="Couldn't load pod-wide proactive defaults." />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3 rounded-medium ring-1 ring-inset ring-foreground/10 bg-foreground/[0.02] px-3 py-2.5">
            <div className="flex flex-col gap-0.5">
              <span className="text-[12.5px] font-medium text-foreground">
                Proactive AI enabled by default
              </span>
              <span className="text-[11px] text-foreground/65">
                Whether new workspaces start with proactive nudges on
              </span>
            </div>
            <Switch
              size="sm"
              isSelected={draft.enabled}
              onValueChange={(v) => updateDraft({ enabled: v })}
              isDisabled={setMutation.isPending}
              aria-label="Proactive AI enabled by default"
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-medium ring-1 ring-inset ring-foreground/10 bg-foreground/[0.02] px-3 py-2.5">
            <div className="flex flex-col gap-0.5">
              <span className="text-[12.5px] font-medium text-foreground">
                Default nudge density
              </span>
              <span className="text-[11px] text-foreground/65">
                How chatty proactive AI is by default
              </span>
            </div>
            <Select
              size="sm"
              radius="md"
              variant="bordered"
              className="max-w-[200px]"
              selectedKeys={[draft.nudgeDensity]}
              onSelectionChange={(keys) => {
                const k = Array.from(keys as Set<string>)[0];
                if (k === "low" || k === "medium" || k === "high") {
                  updateDraft({ nudgeDensity: k });
                }
              }}
              isDisabled={setMutation.isPending}
              aria-label="Default nudge density"
            >
              <SelectItem key="low">low</SelectItem>
              <SelectItem key="medium">medium</SelectItem>
              <SelectItem key="high">high</SelectItem>
            </Select>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-medium ring-1 ring-inset ring-foreground/10 bg-foreground/[0.02] px-3 py-2.5">
            <div className="flex flex-col gap-0.5">
              <span className="text-[12.5px] font-medium text-foreground">
                Morning briefing
              </span>
              <span className="text-[11px] text-foreground/65">
                Cron-driven daily summary in personal channel
              </span>
            </div>
            <Switch
              size="sm"
              isSelected={draft.schedules.morningBriefing}
              onValueChange={(v) => updateSchedule("morningBriefing", v)}
              isDisabled={setMutation.isPending}
              aria-label="Morning briefing enabled"
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-medium ring-1 ring-inset ring-foreground/10 bg-foreground/[0.02] px-3 py-2.5">
            <div className="flex flex-col gap-0.5">
              <span className="text-[12.5px] font-medium text-foreground">
                Weekly digest
              </span>
              <span className="text-[11px] text-foreground/65">
                A Sunday summary of the week
              </span>
            </div>
            <Switch
              size="sm"
              isSelected={draft.schedules.weeklyDigest}
              onValueChange={(v) => updateSchedule("weeklyDigest", v)}
              isDisabled={setMutation.isPending}
              aria-label="Weekly digest enabled"
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-medium ring-1 ring-inset ring-foreground/10 bg-foreground/[0.02] px-3 py-2.5">
            <div className="flex flex-col gap-0.5">
              <span className="text-[12.5px] font-medium text-foreground">
                Health check
              </span>
              <span className="text-[11px] text-foreground/65">
                Daily AI sanity sweep across the workspace
              </span>
            </div>
            <Switch
              size="sm"
              isSelected={draft.schedules.healthCheck}
              onValueChange={(v) => updateSchedule("healthCheck", v)}
              isDisabled={setMutation.isPending}
              aria-label="Health check enabled"
            />
          </div>
        </div>
      )}
    </SectionCard>
  );
}

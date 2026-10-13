"use client";

/**
 * `/open/automation/:id` — one rule, hosted on the web (D6).
 *
 * Read doors are user-floored (`automations.get` / `automations.listRuns`,
 * `protectedProcedure`), so a member who was sent the link reads what the pod
 * would show them anywhere. The one act offered here is PAUSE — de-escalation,
 * which the pod never sends for review ("stopping a misbehaving automation
 * never waits", `automations.pause`). Switching it back on and running it now
 * are governed (an agent proposes, a person decides) and authoring lives in
 * the app, so both stay behind "Open in app".
 */

import { useState } from "react";
import { Button } from "@heroui/react";
import { Play } from "lucide-react";
import { humanizeToken } from "@synap-core/types/vocabulary";
import { trpc } from "../../../lib/trpc";
import { formatRelative } from "../../../lib/format";
import { ConfirmModal } from "../../(admin)/components/confirm-modal";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../(admin)/components/resource-row";
import { ErrorNote, errorDetail } from "../../_lib/copy-button";
import { statusPillFor } from "../../_lib/object/tone";
import {
  automationSummary,
  couldNotLoad,
  loadFailure,
  runLine,
  shortDescription,
} from "../open-model";
import {
  OpenFailure,
  OpenInAppLink,
  OpenLoading,
  OpenObject,
} from "../open-shell";
import { useReauthOnUnauthorized } from "./use-reauth";

const RECENT_RUNS = 5;

export function AutomationView({ id }: { id: string }) {
  const utils = trpc.useUtils();
  const query = trpc.automations.get.useQuery({ id }, { retry: false });
  const runs = trpc.automations.listRuns.useQuery(
    { automationId: id, limit: RECENT_RUNS },
    { enabled: query.isSuccess, retry: false }
  );
  const [confirmPause, setConfirmPause] = useState(false);
  const pause = trpc.automations.pause.useMutation({
    onSuccess: async () => {
      setConfirmPause(false);
      await utils.automations.get.invalidate({ id });
    },
  });
  useReauthOnUnauthorized(query.error, runs.error, pause.error);

  if (query.isLoading) return <OpenLoading label="Loading rule…" />;
  const rule = query.data;
  const fail = loadFailure(query.error, "Rule");
  if (fail || !rule) {
    return (
      <OpenFailure
        kind="automation"
        id={id}
        failure={fail ?? couldNotLoad("Rule")}
      />
    );
  }

  const canPause = rule.status === "active";
  const trigger = humanizeToken(rule.triggerType);

  return (
    <OpenObject
      header={{
        kind: "automation",
        noun: `Rule · ${trigger.toLowerCase()}`,
        title: rule.name,
        summary: automationSummary(rule),
        status: statusPillFor(rule.status),
        primaryAction: canPause ? (
          <Button
            size="sm"
            radius="md"
            color="warning"
            variant="flat"
            onPress={() => setConfirmPause(true)}
          >
            Pause
          </Button>
        ) : undefined,
        secondaryActions: <OpenInAppLink type="automation" id={id} />,
      }}
      facts={[
        { label: "Runs on", value: trigger },
        {
          label: "Last run",
          value: formatRelative(rule.lastRunAt, { empty: "Never" }),
        },
        ...(rule.nextRunAt
          ? [{ label: "Next run", value: formatRelative(rule.nextRunAt) }]
          : []),
        {
          label: "Runs",
          value:
            rule.failureCount > 0
              ? `${rule.runCount} · ${rule.failureCount} failed`
              : String(rule.runCount),
        },
      ]}
      advanced={{
        ids: [
          { label: "Rule id", value: rule.id },
          ...(rule.workspaceId
            ? [{ label: "Space id", value: rule.workspaceId }]
            : []),
        ],
      }}
    >
      {shortDescription(rule.description) && (
        <p className="text-[13px] leading-relaxed text-foreground/80">
          {shortDescription(rule.description)}
        </p>
      )}
      {pause.error && pause.error.data?.code !== "UNAUTHORIZED" && (
        <ErrorNote
          message={
            pause.error.data?.code === "FORBIDDEN"
              ? "You can’t pause this rule. Only the person who made it, or an admin of its space, can."
              : "The rule couldn’t be paused. Try again."
          }
          detail={errorDetail(pause.error)}
        />
      )}
      <section className="flex flex-col gap-2">
        <h2 className="text-[13px] font-medium text-foreground">Recent runs</h2>
        {runs.isLoading ? (
          <ResourceRowSkeleton count={2} />
        ) : runs.error ? (
          <ResourceRowError
            message="Runs couldn’t be loaded."
            onRetry={() => void runs.refetch()}
          />
        ) : (runs.data?.runs.length ?? 0) === 0 ? (
          <ResourceRowEmpty message="This rule hasn’t run yet." />
        ) : (
          <div className="-mx-2">
            {runs.data?.runs.map((run) => {
              const line = runLine(run);
              return (
                <ResourceRow
                  key={run.id}
                  Icon={Play}
                  primary={line.primary}
                  secondary={line.secondary}
                  status={statusPillFor(run.status) ?? undefined}
                  wrap
                />
              );
            })}
          </div>
        )}
      </section>
      <ConfirmModal
        isOpen={confirmPause}
        onClose={() => setConfirmPause(false)}
        onConfirm={() => pause.mutate({ id })}
        title={`Pause “${rule.name}”?`}
        consequence={
          <>
            It won’t start new runs until someone switches it back on (in the
            app). Nothing it already did is undone.
          </>
        }
        confirmLabel="Pause rule"
        confirmColor="warning"
        isPending={pause.isPending}
      />
    </OpenObject>
  );
}

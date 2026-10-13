"use client";

/**
 * One rule (an `automation`), the one object page — drawn by `/open/automation/:id`
 * in the receiver card and by `/rules/[id]` in the console (`ObjectFrame`).
 *
 * Read doors are user-floored (`automations.get` / `automations.listRuns`,
 * `protectedProcedure`), so a member who was sent the link reads what the pod
 * would show them anywhere, and an admin reads the same floor (D1a). The one
 * act offered is PAUSE — de-escalation, which the pod never sends for review
 * ("stopping a misbehaving automation never waits", `automations.pause`).
 * Switching it back on and running it now are governed (an agent proposes, a
 * person decides) and authoring lives in the app, so both stay behind "Open
 * in app".
 */

import { useState } from "react";
import { Button } from "@heroui/react";
import { Play } from "lucide-react";
import { ruleWhenWords } from "@synap-core/types/automations";
import { trpc } from "../../../../lib/trpc";
import { formatRelative } from "../../../../lib/format";
import { openIn } from "../../../../lib/open-in";
import { ExitLink } from "../../../../lib/exit-link";
import { ConfirmModal } from "../../../(admin)/components/confirm-modal";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../../(admin)/components/resource-row";
import { ErrorNote, errorDetail } from "../../copy-button";
import { statusPillFor } from "../tone";
import {
  automationSummary,
  couldNotLoad,
  loadFailure,
  runLine,
  shortDescription,
} from "../../../open/open-model";
import { useReauthOnUnauthorized } from "../../../open/_views/use-reauth";
import type { ObjectFrame } from "./object-frame";

/** Runs the Runs tab lists — the same window the console's run drawer reads. */
const RUNS_SHOWN = 25;

export function AutomationObject({
  id,
  frame,
}: {
  id: string;
  frame: ObjectFrame;
}) {
  const utils = trpc.useUtils();
  const query = trpc.automations.get.useQuery({ id }, { retry: false });
  const runs = trpc.automations.listRuns.useQuery(
    { automationId: id, limit: RUNS_SHOWN },
    { enabled: query.isSuccess, retry: false }
  );
  // A space id is not a space. `list` is the reader's own cached array; a
  // pod-wide rule (no space) never asks.
  const spaces = trpc.workspaces.list.useQuery(undefined, {
    enabled: Boolean(query.data?.workspaceId),
    retry: false,
  });
  const [confirmPause, setConfirmPause] = useState(false);
  const pause = trpc.automations.pause.useMutation({
    onSuccess: async () => {
      setConfirmPause(false);
      await utils.automations.get.invalidate({ id });
    },
  });
  useReauthOnUnauthorized(query.error, runs.error, pause.error);

  if (query.isLoading) return frame.loading("Loading rule…");
  const rule = query.data;
  const fail = loadFailure(query.error, "Rule");
  if (fail || !rule) {
    return frame.failure({
      kind: "automation",
      id,
      failure: fail ?? couldNotLoad("Rule"),
    });
  }

  const canPause = rule.status === "active";
  const when = ruleWhenWords(
    rule.triggerType,
    rule.triggerConfig as Record<string, unknown> | null
  );
  const spaceName = rule.workspaceId
    ? (spaces.data ?? []).find((s) => s.id === rule.workspaceId)?.name
    : null;
  const description = shortDescription(rule.description);
  const runRows = runs.data?.runs ?? [];

  return (
    <>
      {frame.object({
        header: {
          kind: "automation",
          noun: "Rule",
          title: rule.name,
          summary: automationSummary(rule),
          status: statusPillFor(rule.status),
          breadcrumb: frame.breadcrumb?.(rule.name),
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
          secondaryActions: (
            <ExitLink
              exit={openIn({
                kind: "objectInApp",
                objectKind: "automation",
                id,
              })}
              label="Open in app"
            />
          ),
        },
        facts: [
          { label: "Runs on", value: when.text },
          ...(rule.workspaceId
            ? [{ label: "Space", value: spaceName ?? "A space" }]
            : [{ label: "Space", value: "All spaces" }]),
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
        ],
        children: pause.error && pause.error.data?.code !== "UNAUTHORIZED" && (
          <ErrorNote
            message={
              pause.error.data?.code === "FORBIDDEN"
                ? "You can’t pause this rule. Only the person who made it, or an admin of its space, can."
                : "The rule couldn’t be paused. Try again."
            }
            detail={errorDetail(pause.error)}
          />
        ),
        tabs: [
          {
            key: "overview",
            label: "Overview",
            content: (
              <div className="flex flex-col gap-4">
                {description && (
                  <p className="text-[13px] leading-relaxed text-foreground/80">
                    {description}
                  </p>
                )}
                <dl className="flex flex-col gap-2 text-[13px]">
                  <div className="flex flex-col gap-0.5">
                    <dt className="text-[12px] text-foreground/65">When</dt>
                    <dd className="text-foreground">{when.text}</dd>
                  </div>
                  {when.onlyIf.length > 0 && (
                    <div className="flex flex-col gap-0.5">
                      <dt className="text-[12px] text-foreground/65">
                        Only if
                      </dt>
                      <dd className="text-foreground">
                        {when.onlyIf.join(" and ")}
                      </dd>
                    </div>
                  )}
                </dl>
              </div>
            ),
          },
          {
            key: "runs",
            label: rule.runCount > 0 ? `Runs (${rule.runCount})` : "Runs",
            content: runs.isLoading ? (
              <ResourceRowSkeleton count={3} />
            ) : runs.error ? (
              <ResourceRowError
                message="Runs couldn’t be loaded."
                onRetry={() => void runs.refetch()}
              />
            ) : runRows.length === 0 ? (
              <ResourceRowEmpty message="This rule hasn’t run yet." />
            ) : (
              <div className="-mx-2">
                {runRows.map((run) => {
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
                {rule.runCount > runRows.length && (
                  <p className="px-3 pt-2 text-[12px] text-foreground/65">
                    The newest {runRows.length} of {rule.runCount} runs.
                  </p>
                )}
              </div>
            ),
          },
        ],
        advanced: {
          ids: [
            { label: "Rule id", value: rule.id },
            ...(rule.workspaceId
              ? [{ label: "Space id", value: rule.workspaceId }]
              : []),
          ],
        },
      })}
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
    </>
  );
}

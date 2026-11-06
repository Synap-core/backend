"use client";

/**
 * One capability, the one object page — drawn by `/open/capability/:id` in the
 * receiver card. It is where every "not enabled / not connected" refusal sends
 * a person (`openTypedLink("capability", id)` in the pod's enable-link), so it
 * answers the one question those refusals raise: what is blocking it, and can
 * I fix it here?
 *
 * It is also every capability's own page from Tools (one row, one click), so
 * it answers the rest too: is it on, is something running now, what did it
 * run (`ToolRuns`).
 *
 * Reads (all user-floored): `capabilities.containers.get` — the container, its
 * space, and NOT_FOUND for one the reader cannot see — the catalog card
 * (`capabilities.catalog`, the same cached read Tools uses) for its state, its
 * verbs and the pod's own next-step sentence, and its composition
 * (`capabilities.compositions`) for its run health and its rules and
 * templates. The status mark is THE one (`tool-status.ts`), the same the Tools
 * row shows.
 *
 * The acts on the web are turning verbs on or off
 * (`capabilities.setToolEnabled`, the same gate as everywhere: a space's
 * owner, or a pod admin for a pod-wide capability), and turning ON its access
 * to the service when a member tool row is off (`card.toolsOff`,
 * `tools.setApproved`, the same gate). The run gate refuses on that row too,
 * so a capability with every action on and its access off ran nothing, and
 * until 2026-10-30 no screen offered to turn it on (Hetzner Cloud). The
 * switches are offered only to those (`mayTurnVerbsOn`); everyone else reads
 * the state and who can change it. Connecting an account stays in the app — the web has no Connect
 * flow — so that step is a "Connect in app" exit.
 *
 * Under each action that is on: how it runs when an AI asks for it — runs on
 * its own, asks first, never (`governanceRules.actionModes` /
 * `setActionMode`, founder 5 Nov 2026). One mode per action for every AI on
 * the pod, so a pod admin sets it and everyone else reads it. A mode that
 * could not be read says so; it never reads as "asks first".
 */

import { addToast, Chip, Select, SelectItem, Switch } from "@heroui/react";
import { useState } from "react";
import { resolveServiceName } from "@synap-core/types/service-marks";
import { buildObjectActionTitle } from "@synap-core/types/vocabulary";
import { trpc } from "../../../../lib/trpc";
import {
  useSetToolApproved,
  useSetToolEnabled,
} from "../../presence/use-request-doors";
import { readableError } from "../../../../lib/format";
import { ExitLink } from "../../../../lib/exit-link";
import { openIn } from "../../../../lib/open-in";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import {
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../../(admin)/components/resource-row";
import {
  CAPABILITY_READ_OPTIONS,
  CATALOG_INPUT,
} from "../../../(admin)/tools/_lib/tools-model";
import {
  toolGroups,
  type CardVerbLike,
} from "../../../(admin)/tools/_lib/installed-model";
import { capabilityStatus } from "../../../(admin)/tools/_lib/tool-status";
import { toolsT } from "../../../(admin)/tools/_lib/copy";
import {
  actionLabelFor,
  capabilityFlows,
} from "../../../(admin)/tools/_lib/tool-runs-model";
import { mayTurnVerbsOn, whoTurnsVerbsOn } from "../capability-model";
import { actionModeChoices, isActionRunMode } from "../action-mode-model";
import { resolveActionRunModeLabel } from "@synap-core/types/vocabulary";
import type { ActionRunMode } from "@synap-core/types/governance-rules";
import { ToolRuns } from "./tool-runs";
import { couldNotLoad, loadFailure } from "../load-failure";
import { useReauthOnUnauthorized } from "../use-reauth";
import { useSetActionMode } from "../../presence/use-sensitive-actions";
import type { ObjectFrame } from "./object-frame";

export function CapabilityObject({
  id,
  frame,
  viewerIsPodAdmin,
}: {
  id: string;
  frame: ObjectFrame;
  /** Offers the pod-wide switches; the pod re-checks every one. */
  viewerIsPodAdmin: boolean;
}) {
  const utils = trpc.useUtils();
  const container = trpc.capabilities.containers.get.useQuery(
    { id },
    { retry: false }
  );
  const catalog = trpc.capabilities.catalog.useQuery(CATALOG_INPUT, {
    ...CAPABILITY_READ_OPTIONS,
    enabled: container.isSuccess,
  });
  const compositions = trpc.capabilities.compositions.useQuery(undefined, {
    ...CAPABILITY_READ_OPTIONS,
    enabled: container.isSuccess,
  });
  const workspaceId = container.data?.capability.workspaceId ?? null;
  const spaces = trpc.workspaces.list.useQuery(undefined, {
    enabled: Boolean(workspaceId),
    retry: false,
  });

  // The pod's own words when it refuses a switch, under the verb it refused.
  const [refusals, setRefusals] = useState<Record<string, string>>({});
  // With the proof of presence: turning a verb ON is setup (W3).
  // The dialog names the verb the call turns on.
  const setEnabled = useSetToolEnabled(
    (input) => {
      const verb = verbs.find((v) => v.skillId === input.skillId);
      return verb
        ? buildObjectActionTitle({
            action: "turn_on",
            objectKind: "skill",
            objectName: verb.label,
          })
        : null;
    },
    {
      onSuccess: (_res, input) => {
        setRefusals(({ [input.skillId]: _dropped, ...rest }) => rest);
        void utils.capabilities.catalog.invalidate();
        void utils.diagnose.global.invalidate();
      },
      onError: (err, input) => {
        if (redirectToLoginIfUnauthorized(err)) return;
        setRefusals((r) => ({
          ...r,
          [input.skillId]:
            readableError(err.message) ?? "The pod didn’t change this action.",
        }));
        addToast({
          title: "That action wasn’t changed",
          description: readableError(err.message),
          color: "danger",
        });
      },
    }
  );
  // Its access to the service (a member tool row the run gate refuses).
  const [accessRefusals, setAccessRefusals] = useState<Record<string, string>>(
    {}
  );
  // With the proof of presence: turning a tool ON is setup (W3).
  const setAccess = useSetToolApproved(null, {
    onSuccess: (_res, input) => {
      setAccessRefusals(({ [input.id]: _dropped, ...rest }) => rest);
      void utils.capabilities.catalog.invalidate();
      void utils.diagnose.global.invalidate();
    },
    onError: (err, input) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      setAccessRefusals((r) => ({
        ...r,
        [input.id]: readableError(err.message) ?? toolsT()("access.notChanged"),
      }));
    },
  });
  // How each action runs (one mode per action, every AI, the whole pod).
  const modeCard = (catalog.data ?? []).find((c) => c.id === id);
  const actionNames = modeCard
    ? (toolGroups([modeCard])[0]?.verbs ?? []).map((v) => v.verbId)
    : [];
  const modes = trpc.governanceRules.actionModes.useQuery(
    { actions: actionNames },
    { enabled: actionNames.length > 0, retry: false }
  );
  const [modeRefusals, setModeRefusals] = useState<Record<string, string>>({});
  // With the proof of presence (W3 slice 3): a sensitive action.
  const setMode = useSetActionMode({
    onSuccess: (_res, input) => {
      setModeRefusals(({ [input.action]: _dropped, ...rest }) => rest);
      void utils.governanceRules.actionModes.invalidate();
      void utils.governanceRules.list.invalidate();
      void utils.governanceRules.listAll.invalidate();
    },
    onError: (err, input) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      setModeRefusals((r) => ({
        ...r,
        [input.action]:
          readableError(err.message) ?? "The pod didn’t change how it runs.",
      }));
    },
  });
  useReauthOnUnauthorized(container.error, catalog.error);

  if (container.isLoading) return frame.loading("Loading tool…");
  const cap = container.data?.capability;
  const fail = loadFailure(container.error, "Tool");
  if (fail || !cap) {
    return frame.failure({
      kind: "capability",
      id,
      failure: fail ?? couldNotLoad("Tool"),
    });
  }

  const card = (catalog.data ?? []).find((c) => c.id === id);
  const composition = (compositions.data ?? []).find((c) => c.id === id);
  const space = workspaceId
    ? (spaces.data ?? []).find((s) => s.id === workspaceId)
    : undefined;
  const spaceName = workspaceId ? (space?.name ?? "a space") : null;
  const canToggle = mayTurnVerbsOn({
    workspaceId,
    roleInSpace: space?.role,
    viewerIsPodAdmin,
  });
  const verbs = card ? (toolGroups([card])[0]?.verbs ?? []) : [];
  const next = card?.nextAction;
  const connectExit = openIn({
    kind: "objectInApp",
    objectKind: "capability",
    id,
  });
  const accessOff = card?.toolsOff ?? [];
  const pendingAccess = setAccess.isPending
    ? setAccess.variables?.id
    : undefined;
  const pendingSkill = setEnabled.isPending
    ? setEnabled.variables?.skillId
    : undefined;

  const verbsBody = catalog.isLoading ? (
    <ResourceRowSkeleton count={3} />
  ) : catalog.isError ? (
    <ResourceRowError
      message="Its actions couldn’t be loaded."
      onRetry={() => void catalog.refetch()}
    />
  ) : verbs.length === 0 ? (
    <ResourceRowEmpty message="It brings no actions that can be turned on or off." />
  ) : (
    <ul className="-mx-2 flex flex-col">
      {verbs.map((v) => (
        <VerbRow
          key={v.verbId}
          verb={v}
          canToggle={canToggle}
          isPending={pendingSkill === v.skillId}
          refusal={v.skillId ? refusals[v.skillId] : undefined}
          onToggle={(enabled) =>
            v.skillId && setEnabled.mutate({ skillId: v.skillId, enabled })
          }
          runMode={
            modes.isError
              ? { state: "failed" }
              : modes.data
                ? (() => {
                    const row = modes.data.modes.find(
                      (m) => m.action === v.verbId
                    );
                    return row
                      ? {
                          state: "ready",
                          mode: row.mode,
                          mayRunOnItsOwn: row.mayRunOnItsOwn,
                        }
                      : { state: "failed" };
                  })()
                : { state: "loading" }
          }
          canSetMode={viewerIsPodAdmin}
          modePending={
            setMode.isPending && setMode.variables?.action === v.verbId
          }
          modeRefusal={modeRefusals[v.verbId]}
          onSetMode={(mode) => setMode.mutate({ action: v.verbId, mode })}
        />
      ))}
    </ul>
  );

  return frame.object({
    header: {
      kind: "capability",
      title: card?.name ?? cap.name,
      summary:
        next?.hint ??
        (catalog.isLoading ? undefined : "Its state couldn’t be read."),
      // Nothing until both halves answered or failed: a mark that flips from
      // "On" to "2 failed runs" a second later would be read as the answer.
      status:
        catalog.isLoading || compositions.isLoading
          ? null
          : capabilityStatus({
              card: card ?? null,
              health: composition?.health ?? null,
            }),
      breadcrumb: frame.breadcrumb?.(card?.name ?? cap.name),
      primaryAction:
        next?.kind === "connect" ? (
          <ExitLink exit={connectExit} label="Connect in app" />
        ) : undefined,
      secondaryActions:
        next?.kind === "connect" ? undefined : (
          <ExitLink exit={connectExit} label="Open in app" />
        ),
    },
    facts: [
      { label: "Space", value: spaceName ?? "Whole pod" },
      ...(card?.connection?.required && card.connection.provider
        ? [{ label: "Account", value: card.connection.provider }]
        : []),
      ...(verbs.length > 0
        ? [
            {
              label: "Actions on",
              value: `${verbs.filter((v) => v.enabled).length} of ${verbs.length}`,
            },
          ]
        : []),
    ],
    children: (
      <>
        {accessOff.length > 0 && (
          <AccessSection
            tools={accessOff}
            canToggle={canToggle}
            who={
              workspaceId
                ? toolsT()("access.whoSpace", { space: spaceName ?? "" })
                : toolsT()("access.who")
            }
            pendingId={pendingAccess}
            refusals={accessRefusals}
            onTurnOn={(toolId) =>
              setAccess.mutate({ id: toolId, approved: true })
            }
          />
        )}
        <section className="flex flex-col gap-2">
          <h2 className="text-[13px] font-medium text-foreground">Actions</h2>
          {!canToggle && verbs.length > 0 && (
            <p className="text-[12.5px] text-foreground/65">
              {whoTurnsVerbsOn(workspaceId ? spaceName : null)}
            </p>
          )}
          {verbsBody}
        </section>
        <ToolRuns
          tool={{ capabilityId: id }}
          flows={capabilityFlows(composition?.members ?? [])}
          actionLabel={actionLabelFor(card?.verbs ?? [])}
        />
      </>
    ),
    advanced: {
      ids: [
        { label: "Tool id", value: cap.id },
        ...(workspaceId ? [{ label: "Space id", value: workspaceId }] : []),
      ],
      ...(card ? { raw: card } : {}),
    },
  });
}

/**
 * Its access to the service, off: one row per member tool row the run gate
 * refuses, with its switch. Only drawn while one is off; once on, the card no
 * longer lists it and the section goes.
 */
function AccessSection({
  tools,
  canToggle,
  who,
  pendingId,
  refusals,
  onTurnOn,
}: {
  tools: ReadonlyArray<{ id: string; name: string }>;
  canToggle: boolean;
  who: string;
  pendingId: string | undefined;
  refusals: Record<string, string>;
  onTurnOn: (toolId: string) => void;
}) {
  const t = toolsT();
  return (
    <section
      data-capability-access=""
      className="flex flex-col gap-2"
      aria-label={t("access.title")}
    >
      <h2 className="text-[13px] font-medium text-foreground">
        {t("access.title")}
      </h2>
      {!canToggle && <p className="text-[12.5px] text-foreground/65">{who}</p>}
      <ul className="-mx-2 flex flex-col">
        {tools.map((tool) => {
          const service = resolveServiceName(tool.name);
          return (
            <li
              key={tool.id}
              data-access-tool={tool.id}
              className="flex flex-col gap-1 border-b border-foreground/[0.05] px-2 py-2 last:border-b-0"
            >
              <div className="flex min-h-10 items-center gap-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px] text-foreground">
                    {t("access.row", { service })}
                  </span>
                  <span className="text-[11.5px] text-foreground/65">
                    {t("access.why", { service })}
                  </span>
                </div>
                {canToggle ? (
                  <Switch
                    size="sm"
                    isSelected={false}
                    isDisabled={pendingId === tool.id}
                    onValueChange={(on) => on && onTurnOn(tool.id)}
                    aria-label={t("access.turnOn", { service })}
                  />
                ) : (
                  <span className="shrink-0 text-[12px] text-status-down">
                    {t("access.off")}
                  </span>
                )}
              </div>
              {refusals[tool.id] && (
                <p className="text-[12px] text-status-down" role="alert">
                  {refusals[tool.id]}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** An action's run mode as this page holds it: read, still loading, or not readable. */
type RunModeState =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "ready"; mode: ActionRunMode; mayRunOnItsOwn: boolean };

function VerbRow({
  verb,
  canToggle,
  isPending,
  refusal,
  onToggle,
  runMode,
  canSetMode,
  modePending,
  modeRefusal,
  onSetMode,
}: {
  verb: CardVerbLike;
  canToggle: boolean;
  isPending: boolean;
  refusal: string | undefined;
  onToggle: (enabled: boolean) => void;
  runMode: RunModeState;
  /** A pod admin: the mode holds for every AI on the pod. */
  canSetMode: boolean;
  modePending: boolean;
  modeRefusal: string | undefined;
  onSetMode: (mode: ActionRunMode) => void;
}) {
  return (
    <li className="flex flex-col gap-1 border-b border-foreground/[0.05] px-2 py-2 last:border-b-0">
      <div className="flex min-h-10 items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-[12.5px] text-foreground">
              {verb.label}
            </span>
            <Chip
              size="sm"
              radius="sm"
              variant="flat"
              className="h-5 shrink-0 text-[10.5px]"
            >
              {verb.type}
            </Chip>
          </span>
          {verb.description && (
            <span className="line-clamp-2 text-[11.5px] text-foreground/65">
              {verb.description}
            </span>
          )}
        </div>
        {canToggle ? (
          <Switch
            size="sm"
            isSelected={verb.enabled}
            isDisabled={isPending}
            onValueChange={onToggle}
            aria-label={`${verb.enabled ? "Turn off" : "Turn on"} ${verb.label}`}
          />
        ) : (
          <span
            className={`shrink-0 text-[12px] ${verb.enabled ? "text-foreground" : "text-foreground/65"}`}
          >
            {verb.enabled ? "On" : "Off"}
          </span>
        )}
      </div>
      {refusal && (
        <p className="text-[12px] text-status-down" role="alert">
          {refusal}
        </p>
      )}
      {verb.enabled && (
        <RunModeLine
          verb={verb}
          runMode={runMode}
          canSetMode={canSetMode}
          isPending={modePending}
          onSetMode={onSetMode}
        />
      )}
      {modeRefusal && (
        <p className="text-[12px] text-status-down" role="alert">
          {modeRefusal}
        </p>
      )}
    </li>
  );
}

/**
 * How an action that is on runs: a pod admin picks it, everyone else reads
 * it. Loading draws nothing yet; a failed read says so, never "asks first".
 */
function RunModeLine({
  verb,
  runMode,
  canSetMode,
  isPending,
  onSetMode,
}: {
  verb: CardVerbLike;
  runMode: RunModeState;
  canSetMode: boolean;
  isPending: boolean;
  onSetMode: (mode: ActionRunMode) => void;
}) {
  if (runMode.state === "loading") return null;
  if (runMode.state === "failed") {
    return (
      <p className="text-[12px] text-foreground/65">
        How it runs couldn’t be read.
      </p>
    );
  }
  const choices = actionModeChoices({
    type: verb.type,
    mayRunOnItsOwn: runMode.mayRunOnItsOwn,
  });
  const current = choices.find((c) => c.mode === runMode.mode);
  return (
    <div
      data-action-mode={runMode.mode}
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
    >
      <span className="text-[12px] text-foreground/65">When an AI uses it</span>
      {canSetMode ? (
        <Select
          size="sm"
          radius="md"
          variant="bordered"
          className="w-full max-w-[220px]"
          aria-label={`How ${verb.label} runs`}
          selectedKeys={[runMode.mode]}
          disabledKeys={choices.filter((c) => c.disabled).map((c) => c.mode)}
          isDisabled={isPending}
          onSelectionChange={(keys) => {
            const k = Array.from(keys as Set<string>)[0];
            if (isActionRunMode(k) && k !== runMode.mode) onSetMode(k);
          }}
        >
          {choices.map((c) => (
            <SelectItem key={c.mode} description={c.line}>
              {c.label}
            </SelectItem>
          ))}
        </Select>
      ) : (
        <span className="text-[12px] text-foreground">
          {resolveActionRunModeLabel(runMode.mode)}
        </span>
      )}
      {current && (
        <span className="w-full text-[11.5px] text-foreground/65">
          {current.line}
        </span>
      )}
    </div>
  );
}

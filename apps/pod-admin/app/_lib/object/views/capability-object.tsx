"use client";

/**
 * One capability, the one object page — drawn by `/open/capability/:id` in the
 * receiver card. It is where every "not enabled / not connected" refusal sends
 * a person (`openTypedLink("capability", id)` in the pod's enable-link), so it
 * answers the one question those refusals raise: what is blocking it, and can
 * I fix it here?
 *
 * Reads (both user-floored): `capabilities.containers.get` — the container, its
 * space, and NOT_FOUND for one the reader cannot see — and the catalog card
 * (`capabilities.catalog`, the same cached read Marketplace › Tools uses) for
 * its state, its verbs and the pod's own next-step sentence.
 *
 * The one act on the web is turning verbs on or off
 * (`capabilities.setToolEnabled`, the same gate as everywhere: a space's
 * owner, or a pod admin for a pod-wide capability). The switches are offered
 * only to those (`mayTurnVerbsOn`); everyone else reads the state and who can
 * change it. Connecting an account stays in the app — the web has no Connect
 * flow — so that step is a "Connect in app" exit.
 */

import { addToast, Chip, Switch } from "@heroui/react";
import { useState } from "react";
import { trpc } from "../../../../lib/trpc";
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
} from "../../../(admin)/marketplace/_lib/installed-tab";
import {
  toolGroups,
  type CardVerbLike,
} from "../../../(admin)/marketplace/_lib/installed-model";
import {
  capabilityStatusPill,
  mayTurnVerbsOn,
  whoTurnsVerbsOn,
} from "../capability-model";
import { couldNotLoad, loadFailure } from "../load-failure";
import { useReauthOnUnauthorized } from "../use-reauth";
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
  const workspaceId = container.data?.capability.workspaceId ?? null;
  const spaces = trpc.workspaces.list.useQuery(undefined, {
    enabled: Boolean(workspaceId),
    retry: false,
  });

  // The pod's own words when it refuses a switch, under the verb it refused.
  const [refusals, setRefusals] = useState<Record<string, string>>({});
  const setEnabled = trpc.capabilities.setToolEnabled.useMutation({
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
      status: card ? capabilityStatusPill(card.status) : null,
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
      <section className="flex flex-col gap-2">
        <h2 className="text-[13px] font-medium text-foreground">Actions</h2>
        {!canToggle && verbs.length > 0 && (
          <p className="text-[12.5px] text-foreground/65">
            {whoTurnsVerbsOn(workspaceId ? spaceName : null)}
          </p>
        )}
        {verbsBody}
      </section>
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

function VerbRow({
  verb,
  canToggle,
  isPending,
  refusal,
  onToggle,
}: {
  verb: CardVerbLike;
  canToggle: boolean;
  isPending: boolean;
  refusal: string | undefined;
  onToggle: (enabled: boolean) => void;
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
    </li>
  );
}

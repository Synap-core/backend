"use client";

/**
 * Marketplace › Tools — every verb an installed capability brings, and whether
 * it is turned on. A verb that is off is refused every time something calls
 * it; turning it on is `capabilities.setToolEnabled` (the backing skill's
 * `approved`, the flag the execution gate reads — D5).
 *
 * Who may flip one is the pod's call, not this page's: a pod-wide verb needs a
 * pod admin, a space's verb needs that space's owner. The switch is always
 * shown; a refusal is printed under the verb as the pod worded it.
 * `?focus=<capabilityId>` opens and highlights that capability.
 */

import { Chip, Switch, addToast } from "@heroui/react";
import { ChevronRight } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { trpc } from "../../../../lib/trpc";
import { readableError } from "../../../../lib/format";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { kindIcon } from "../../../_lib/object/kind-icon";
import { StatusPill } from "../../components/status-pill";
import {
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { useFocusRow } from "../../components/use-focus-row";
import {
  toolGroups,
  toolsSummary,
  type CardVerbLike,
  type ToolGroup,
} from "./installed-model";
import { CAPABILITY_READ_OPTIONS, CATALOG_INPUT } from "./installed-tab";

const CapabilityIcon = kindIcon("capability");

export function ToolsTab() {
  const utils = trpc.useUtils();
  const catalog = trpc.capabilities.catalog.useQuery(
    CATALOG_INPUT,
    CAPABILITY_READ_OPTIONS
  );
  const focusId = useSearchParams().get("focus");

  useEffect(() => {
    if (catalog.error) redirectToLoginIfUnauthorized(catalog.error);
  }, [catalog.error]);
  useFocusRow({ ready: !catalog.isLoading });

  const groups = useMemo(() => toolGroups(catalog.data ?? []), [catalog.data]);

  // The pod's own words when it refuses a switch, under the verb it refused.
  const [refusals, setRefusals] = useState<Record<string, string>>({});
  const setEnabled = trpc.capabilities.setToolEnabled.useMutation({
    onSuccess: (_res, input) => {
      setRefusals(({ [input.skillId]: _dropped, ...rest }) => rest);
      void utils.capabilities.catalog.invalidate();
      // Home's capabilities row counts the same verbs.
      void utils.diagnose.global.invalidate();
    },
    onError: (err, input) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      setRefusals((r) => ({ ...r, [input.skillId]: err.message }));
      addToast({
        title: "That tool wasn’t changed",
        description: readableError(err.message),
        color: "danger",
      });
    },
  });
  const pendingSkill = setEnabled.isPending
    ? setEnabled.variables?.skillId
    : undefined;

  if (catalog.isLoading)
    return (
      <section className="rounded-lg bg-foreground/[0.02] ring-1 ring-inset ring-foreground/10">
        <ResourceRowSkeleton count={4} />
      </section>
    );
  if (catalog.isError)
    return (
      <section className="rounded-lg bg-foreground/[0.02] ring-1 ring-inset ring-foreground/10">
        <ResourceRowError
          message="Couldn't load the installed tools."
          onRetry={() => void catalog.refetch()}
        />
      </section>
    );
  if (groups.length === 0)
    return (
      <section className="rounded-lg bg-foreground/[0.02] ring-1 ring-inset ring-foreground/10">
        <ResourceRowEmpty message="No installed capability brings a tool yet." />
      </section>
    );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12.5px] text-foreground/65">{toolsSummary(groups)}</p>
      <div className="flex flex-col gap-2">
        {groups.map((g) => (
          <ToolGroupView
            key={g.id}
            group={g}
            // Open what needs a look, and what a link pointed at.
            defaultOpen={g.off > 0 || g.id === focusId}
            pendingSkill={pendingSkill}
            refusals={refusals}
            onToggle={(v, enabled) =>
              v.skillId && setEnabled.mutate({ skillId: v.skillId, enabled })
            }
          />
        ))}
      </div>
    </div>
  );
}

function ToolGroupView({
  group,
  defaultOpen,
  pendingSkill,
  refusals,
  onToggle,
}: {
  group: ToolGroup;
  defaultOpen: boolean;
  pendingSkill: string | undefined;
  refusals: Record<string, string>;
  onToggle: (verb: CardVerbLike, enabled: boolean) => void;
}) {
  const on = group.verbs.length - group.off;
  // Read once: turning the last verb on must not snap the group shut under
  // the reader's cursor. After mount the reader owns open/closed.
  const [initiallyOpen] = useState(defaultOpen);
  return (
    <details
      data-row-id={group.id}
      open={initiallyOpen}
      className="group/tools rounded-lg bg-foreground/[0.02] ring-1 ring-inset ring-foreground/10"
    >
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-3 py-2 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="h-3.5 w-3.5 shrink-0 text-foreground/45 transition-transform group-open/tools:rotate-90"
        />
        <CapabilityIcon
          aria-hidden
          className="h-4 w-4 shrink-0 text-foreground/40"
          strokeWidth={2}
        />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
          {group.name}
        </span>
        <span className="hidden shrink-0 text-[11.5px] tabular text-foreground/65 sm:inline">
          {on} of {group.verbs.length} on
        </span>
        {group.off > 0 && (
          <StatusPill kind="stale" label={`${group.off} off`} />
        )}
      </summary>
      <ul className="border-t border-foreground/[0.05]">
        {group.verbs.map((v) => (
          <li
            key={v.verbId}
            className="flex flex-col gap-1 border-b border-foreground/[0.05] px-3 py-2 last:border-b-0 sm:pl-10"
          >
            <div className="flex items-center gap-3">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-mono text-[12.5px] text-foreground">
                    {v.label}
                  </span>
                  <Chip
                    size="sm"
                    radius="sm"
                    variant="flat"
                    className="h-5 shrink-0 text-[10.5px]"
                  >
                    {v.type}
                  </Chip>
                </span>
                {v.description && (
                  <span className="line-clamp-2 text-[11.5px] text-foreground/65">
                    {v.description}
                  </span>
                )}
              </div>
              <Switch
                size="sm"
                isSelected={v.enabled}
                isDisabled={pendingSkill === v.skillId}
                onValueChange={(next) => onToggle(v, next)}
                aria-label={`${v.enabled ? "Turn off" : "Turn on"} ${v.label}`}
              />
            </div>
            {v.skillId && refusals[v.skillId] && (
              <p className="text-[12px] text-status-down" role="alert">
                {refusals[v.skillId]}
              </p>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

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
 * "When an AI uses it" (lane W3, decision b387ca45 D2, D3, D5): the approval
 * rows that name this tool, read from `governanceRules.listAll` (the same
 * rows Approvals lists; no store of its own, `tool-approvals-model.ts`). On
 * top of its actions, every AI × the whole tool (D3: one row naming the
 * container); under each action that is on, every AI × that action (a row on
 * the action outranks the tool's), then the exceptions (one agent, a class, a
 * space), each a door to its agent with Take back. A pod admin changes every
 * AI's mode in ONE call the pod applies in one transaction
 * (`governanceRules.create` with `replacesRuleIds`, or `revoke` with
 * `moreIds`); everyone else reads it. Every AI's mode is decided by the
 * gate's own ranking (`@synap/governance-policy/rule-ranking`). A
 * read that failed says so with a retry; it never reads as "asks first".
 * Whether an action may run on its own at all (a public post never may) is
 * the pod's answer, `governanceRules.actionModes`.
 */

import { addToast, Button, Chip, Switch } from "@heroui/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { PRESENCE_BATCH_MAX } from "@synap-core/types/presence";
import { resolveServiceName } from "@synap-core/types/service-marks";
import {
  buildObjectActionTitle,
  resolveLineageEdgeLabel,
} from "@synap-core/types/vocabulary";
import { trpc } from "../../../../lib/trpc";
import {
  useEnableMany,
  useSetToolApproved,
  useSetToolEnabled,
} from "../../presence/use-request-doors";
import { readableError } from "../../../../lib/format";
import { readableDescription } from "../../../../lib/marketplace";
import { ExitLink } from "../../../../lib/exit-link";
import { openIn } from "../../../../lib/open-in";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../../(admin)/components/resource-row";
import {
  addOnParentHref,
  addOnRows,
  CAPABILITY_READ_OPTIONS,
  CATALOG_INPUT,
  type AddOnRow,
} from "../../../(admin)/tools/_lib/tools-model";
import type {
  CardLike,
  CompositionLike,
} from "../../../(admin)/tools/_lib/installed-model";
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
import { actionModeChoices } from "../action-mode-model";
import { humanizeScope } from "@synap-core/types/governance-rules";
import {
  actionEveryoneState,
  planEveryoneChange,
  toolApprovals,
  toolEveryoneState,
  toolShapeOf,
  verbDisplayName,
  type EveryoneChange,
  type EveryoneValue,
} from "../../../../lib/governance-rules/tool-approvals-model";
import {
  approvalTitle,
  toolNamesOf,
} from "../../../../lib/governance-rules/approvals-model";
import type { GovernanceRuleRow } from "../../../../lib/governance-rules/rule-view-model";
import { navHref } from "../../../../lib/console-nav";
import { useTakeBack } from "../../../(admin)/approvals/_lib/use-take-back";
import {
  ApprovalsReadFailed,
  EveryoneControl,
  ExceptionList,
  type EveryoneRead,
} from "./tool-approvals";
import { objectViewsT } from "./copy";
import { ToolRuns } from "./tool-runs";
import { kindIcon } from "../kind-icon";
import { couldNotLoad, loadFailure } from "../load-failure";
import { useReauthOnUnauthorized } from "../use-reauth";
import { useCreateGovernanceRule } from "../../presence/use-sensitive-actions";
import {
  formatGraceLeft,
  usePresenceGrace,
} from "../../presence/use-presence-grace";
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
  const router = useRouter();
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
  // The approval rows: the same read as Approvals, narrowed here to this tool.
  const rules = trpc.governanceRules.listAll.useQuery(undefined, {
    enabled: container.isSuccess,
    staleTime: 30_000,
    retry: false,
  });
  const ruleRows: GovernanceRuleRow[] = useMemo(
    () => rules.data?.rules ?? [],
    [rules.data]
  );
  const spaces = trpc.workspaces.list.useQuery(undefined, {
    enabled:
      Boolean(workspaceId) ||
      ruleRows.some(
        (r) => r.scopeKind === "workspace" && r.targetKind === "capability"
      ),
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
  // "Turn all on": every action and access still off, ONE confirmation (the
  // challenge names the whole set). The pod answers each item on its own.
  const enableAll = useEnableMany(
    (input) =>
      `Turn on ${(input.skillIds?.length ?? 0) + (input.toolIds?.length ?? 0)} actions`,
    {
      onSuccess: (res) => {
        const failed = res.results.filter((r) => !r.ok);
        setRefusals((prev) => {
          const next = { ...prev };
          for (const r of res.results) {
            if (r.kind === "skill") delete next[r.id];
          }
          for (const r of failed) {
            if (r.kind === "skill" && !r.ok) next[r.id] = r.error;
          }
          return next;
        });
        setAccessRefusals((prev) => {
          const next = { ...prev };
          for (const r of res.results) {
            if (r.kind === "tool") delete next[r.id];
          }
          for (const r of failed) {
            if (r.kind === "tool" && !r.ok) next[r.id] = r.error;
          }
          return next;
        });
        if (failed.length > 0) {
          addToast({
            title: `${failed.length} of ${res.results.length} weren’t turned on`,
            description: "Each one says why, on its row.",
            color: "warning",
          });
        }
        void utils.capabilities.catalog.invalidate();
        void utils.diagnose.global.invalidate();
      },
      onError: (err) => {
        if (redirectToLoginIfUnauthorized(err)) return;
        addToast({
          title: "Nothing was turned on",
          description: readableError(err.message),
          color: "danger",
        });
      },
    }
  );
  const { secondsLeft: graceLeft } = usePresenceGrace();
  // Whether each action may run on its own at all (the pod's answer: a
  // public post never may). Its mode is read from the rows, below.
  const modeCard = (catalog.data ?? []).find((c) => c.id === id);
  const actionNames = modeCard
    ? (toolGroups([modeCard])[0]?.verbs ?? []).map((v) => v.verbId)
    : [];
  const modes = trpc.governanceRules.actionModes.useQuery(
    { actions: actionNames },
    { enabled: actionNames.length > 0, retry: false }
  );
  // Every AI's mode, for the whole tool ("tool") or one action (its verb id).
  const [modeRefusals, setModeRefusals] = useState<Record<string, string>>({});
  const [modePending, setModePending] = useState<string | null>(null);
  const createRule = useCreateGovernanceRule();
  const revokeRule = trpc.governanceRules.revoke.useMutation();
  async function applyEveryone(key: string, change: EveryoneChange) {
    setModePending(key);
    try {
      // ONE call, one transaction on the pod: the new row and the rows it
      // replaces never stand together, and a failure changes nothing.
      const [first, ...more] = change.revoke;
      if (change.create)
        await createRule.mutateAsync({
          ...change.create,
          ...(change.revoke.length > 0
            ? { replacesRuleIds: change.revoke }
            : {}),
        });
      else if (first)
        await revokeRule.mutateAsync({
          id: first,
          ...(more.length > 0 ? { moreIds: more } : {}),
        });
      setModeRefusals(({ [key]: _dropped, ...rest }) => rest);
    } catch (err) {
      const unauthorized = redirectToLoginIfUnauthorized(
        err as { data?: { code?: string | null } | null }
      );
      if (!unauthorized)
        setModeRefusals((r) => ({
          ...r,
          [key]:
            readableError(err instanceof Error ? err.message : null) ??
            objectViewsT()("tool.approvals.notChanged"),
        }));
    } finally {
      setModePending(null);
      void utils.governanceRules.listAll.invalidate();
      void utils.governanceRules.list.invalidate();
      void utils.governanceRules.actionModes.invalidate();
      void utils.governanceRules.matrix.invalidate();
    }
  }
  const toolName = useMemo(
    () => toolNamesOf(catalog.data ?? [], compositions.data ?? []),
    [catalog.data, compositions.data]
  );
  const titleOf = (row: GovernanceRuleRow) => approvalTitle(row, { toolName });
  const takeBack = useTakeBack<GovernanceRuleRow>(titleOf);
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
  // ADD-ONS (founder decision D6): the base this one extends, and the add-ons
  // installed on this one, from the container read.
  const parent = container.data?.extends ?? null;
  const addOns = addOnRows(
    container.data?.addOns ?? [],
    catalog.isSuccess ? (catalog.data as readonly CardLike[]) : null,
    compositions.isSuccess
      ? (compositions.data as readonly CompositionLike[])
      : null
  );
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
  const shape = card ? toolShapeOf(card, composition?.members ?? []) : null;
  const approvals =
    shape && rules.isSuccess ? toolApprovals(ruleRows, shape) : null;
  const approvalsFailed = rules.isError;
  const toolEveryone = approvals ? toolEveryoneState(approvals) : null;
  const spaceNameOf = (wsId: string | null) =>
    (spaces.data ?? []).find((sp) => sp.id === wsId)?.name;
  const whereOf = (row: GovernanceRuleRow) =>
    humanizeScope(row, spaceNameOf(row.workspaceId) ?? undefined);
  const toolRead: EveryoneRead = approvalsFailed
    ? { state: "failed" }
    : toolEveryone
      ? {
          state: "ready",
          everyone: toolEveryone,
          choices: actionModeChoices({
            type: "action",
            mayRunOnItsOwn: true,
            wholeTool: true,
          }),
        }
      : { state: "loading" };
  const actionRead = (v: CardVerbLike): EveryoneRead => {
    if (approvalsFailed || modes.isError) return { state: "failed" };
    if (!approvals || !modes.data) return { state: "loading" };
    const may = modes.data.modes.find((m) => m.action === v.verbId);
    if (!may) return { state: "failed" };
    return {
      state: "ready",
      everyone: actionEveryoneState(approvals, v.verbId),
      choices: actionModeChoices({
        type: v.type,
        mayRunOnItsOwn: may.mayRunOnItsOwn,
        toolMode: toolEveryone?.from === "tool" ? toolEveryone.mode : null,
      }),
    };
  };
  const setActionEveryone = (v: CardVerbLike, next: EveryoneValue) => {
    if (!approvals) return;
    const change = planEveryoneChange({
      pattern: v.verbId,
      level: "action",
      current: approvals.actions[v.verbId]?.everyone ?? [],
      toolMode: toolEveryone?.from === "tool" ? toolEveryone.mode : null,
      next,
    });
    if (change) void applyEveryone(v.verbId, change);
  };
  const setToolEveryone = (next: EveryoneValue) => {
    if (!approvals) return;
    const change = planEveryoneChange({
      pattern: id,
      level: "tool",
      current: approvals.tool.everyone,
      toolMode: null,
      next,
    });
    if (change) void applyEveryone("tool", change);
  };
  const approvalsHref = `${navHref("approvals")}?tool=${encodeURIComponent(id)}`;
  const next = card?.nextAction;
  const connectExit = openIn({
    kind: "objectInApp",
    objectKind: "capability",
    id,
  });
  const accessOff = card?.toolsOff ?? [];
  // At most one confirmation's worth (`PRESENCE_BATCH_MAX`); the rest on the next press.
  const offSkillIds = verbs
    .flatMap((v) => (!v.enabled && v.skillId ? [v.skillId] : []))
    .slice(0, PRESENCE_BATCH_MAX);
  const offToolIds = accessOff
    .map((t) => t.id)
    .slice(0, PRESENCE_BATCH_MAX - offSkillIds.length);
  const offCount = offSkillIds.length + offToolIds.length;
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
          everyone={actionRead(v)}
          canSetMode={viewerIsPodAdmin}
          modePending={modePending === v.verbId}
          modeRefusal={modeRefusals[v.verbId]}
          onSetMode={(next) => setActionEveryone(v, next)}
          exceptions={
            <ExceptionList
              rows={approvals?.actions[v.verbId]?.exceptions ?? []}
              titleOf={titleOf}
              detailOf={() => verbDisplayName(v)}
              whereOf={whereOf}
              readOnly={!viewerIsPodAdmin}
              onTakeBack={takeBack.ask}
            />
          }
        />
      ))}
    </ul>
  );

  return frame.object({
    header: {
      kind: "capability",
      title: card?.name ?? cap.name,
      // What it is (its own description, when written for a reader), then the
      // pod's next-step sentence. An add-on's page names what it does here;
      // its base's Add-ons card shows the same line.
      summary: (() => {
        const hint =
          next?.hint ??
          (catalog.isLoading ? undefined : "Its state couldn’t be read.");
        const description = readableDescription(cap.description);
        if (!description) return hint;
        return (
          <>
            <span
              data-capability-description=""
              className="block text-foreground/80"
            >
              {description}
            </span>
            {hint && <span className="mt-1 block">{hint}</span>}
          </>
        );
      })(),
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
      ...(parent
        ? [
            {
              label: resolveLineageEdgeLabel("extends", "outgoing"),
              value: (
                <a
                  href={addOnParentHref(parent.id)}
                  data-addon-parent=""
                  className="text-primary underline-offset-2 hover:underline"
                >
                  {parent.name}
                </a>
              ),
            },
          ]
        : []),
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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[13px] font-medium text-foreground">Actions</h2>
            {canToggle && offCount > 1 && (
              <div className="flex items-center gap-2">
                {graceLeft !== null && (
                  <span
                    data-presence-grace=""
                    className="text-[11.5px] text-foreground/65"
                  >
                    Confirmed for {formatGraceLeft(graceLeft)}
                  </span>
                )}
                <Button
                  size="sm"
                  variant="flat"
                  isLoading={enableAll.isPending}
                  onPress={() =>
                    enableAll.mutate({
                      skillIds: offSkillIds,
                      toolIds: offToolIds,
                    })
                  }
                >
                  Turn all on
                </Button>
              </div>
            )}
          </div>
          {canToggle && offCount > 1 && (
            <p className="text-[12.5px] text-foreground/65">
              Turns on {offCount} actions. One confirmation.
            </p>
          )}
          {parent && (
            <p className="text-[12.5px] text-foreground/65">
              {toolsT()("addOn.why", { base: parent.name })}
            </p>
          )}
          {!canToggle && verbs.length > 0 && (
            <p className="text-[12.5px] text-foreground/65">
              {whoTurnsVerbsOn(workspaceId ? spaceName : null)}
            </p>
          )}
          {verbs.length > 0 && (
            <div
              data-tool-approvals=""
              className="flex flex-col gap-2 rounded-lg border border-foreground/[0.06] px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-[12.5px] font-medium text-foreground">
                  {objectViewsT()("tool.approvals.title")}
                </h3>
                {viewerIsPodAdmin && (
                  <Link
                    href={approvalsHref}
                    className="text-[12px] font-medium text-primary underline-offset-2 hover:underline"
                  >
                    {objectViewsT()("tool.approvals.all")}
                  </Link>
                )}
              </div>
              {approvalsFailed ? (
                <ApprovalsReadFailed onRetry={() => void rules.refetch()} />
              ) : (
                <>
                  <EveryoneControl
                    label={objectViewsT()("tool.approvals.whole")}
                    ariaLabel={objectViewsT()("tool.approvals.wholeAria", {
                      tool: card?.name ?? cap.name,
                    })}
                    read={toolRead}
                    canSet={viewerIsPodAdmin}
                    isPending={modePending === "tool"}
                    refusal={modeRefusals.tool}
                    onSet={setToolEveryone}
                  />
                  {!viewerIsPodAdmin && (
                    <p className="text-[11.5px] text-foreground/65">
                      {objectViewsT()("tool.approvals.whoSets")}
                    </p>
                  )}
                  <ExceptionList
                    rows={approvals?.tool.exceptions ?? []}
                    titleOf={titleOf}
                    detailOf={() => null}
                    whereOf={whereOf}
                    readOnly={!viewerIsPodAdmin}
                    onTakeBack={takeBack.ask}
                  />
                </>
              )}
            </div>
          )}
          {verbsBody}
        </section>
        {addOns.length > 0 && (
          <AddOnsSection
            base={card?.name ?? cap.name}
            rows={addOns}
            onOpen={(href) => router.push(href)}
          />
        )}
        {takeBack.modal}
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

const AddOnIcon = kindIcon("capability");

/**
 * Its add-ons (founder decision D6): each one is its own tool with its own
 * page, listed here so the base says what extends it. Omitted when it has none.
 */
function AddOnsSection({
  base,
  rows,
  onOpen,
}: {
  base: string;
  rows: AddOnRow[];
  onOpen: (href: string) => void;
}) {
  const t = toolsT();
  return (
    <section
      className="flex flex-col gap-2"
      data-addons=""
      aria-label={t("addOns.title")}
    >
      <h2 className="text-[13px] font-medium text-foreground">
        {t("addOns.title")}
      </h2>
      <p className="text-[12.5px] text-foreground/65">
        {t("addOns.why", { base })}
      </p>
      <div className="-mx-2 divide-y divide-foreground/[0.05]">
        {rows.map((a) => (
          <ResourceRow
            key={a.id}
            Icon={AddOnIcon}
            primary={a.name}
            secondary={a.description ?? undefined}
            status={a.status}
            onSelect={() => onOpen(a.href)}
            wrap
          />
        ))}
      </div>
    </section>
  );
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

function VerbRow({
  verb,
  canToggle,
  isPending,
  refusal,
  onToggle,
  everyone,
  canSetMode,
  modePending,
  modeRefusal,
  onSetMode,
  exceptions,
}: {
  verb: CardVerbLike;
  canToggle: boolean;
  isPending: boolean;
  refusal: string | undefined;
  onToggle: (enabled: boolean) => void;
  everyone: EveryoneRead;
  /** A pod admin: the mode holds for every AI on the pod. */
  canSetMode: boolean;
  modePending: boolean;
  modeRefusal: string | undefined;
  onSetMode: (next: EveryoneValue) => void;
  exceptions: ReactNode;
}) {
  // Its name in words, never its id (finding 47ff4216).
  const name = verbDisplayName(verb);
  return (
    <li
      data-verb={verb.verbId}
      className="flex flex-col gap-1 border-b border-foreground/[0.05] px-2 py-2 last:border-b-0"
    >
      <div className="flex min-h-10 items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <span
              className="truncate text-[13px] text-foreground"
              title={verb.verbId}
            >
              {name}
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
            aria-label={`${verb.enabled ? "Turn off" : "Turn on"} ${name}`}
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
        <>
          <EveryoneControl
            label={objectViewsT()("tool.approvals.title")}
            ariaLabel={objectViewsT()("tool.approvals.actionAria", {
              action: name,
            })}
            read={everyone}
            canSet={canSetMode}
            isPending={modePending}
            refusal={modeRefusal}
            onSet={onSetMode}
          />
          {exceptions}
        </>
      )}
    </li>
  );
}

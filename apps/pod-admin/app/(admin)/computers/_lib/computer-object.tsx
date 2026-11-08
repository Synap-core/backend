"use client";

/**
 * One computer, the one object page — drawn by `/computers/[id]` (pod admin,
 * any member's computer) and `/my-computers/[id]` (the person's own). The
 * route supplies the row (from `machines.adminList` or `machines.list`), the
 * frame, and what the viewer may follow (`links`); everything else is here.
 *
 * The acts — Rename, Change key lifetime, whose computer it is
 * (`setBelongsTo`), Revoke — go through `machines.*`,
 * which let the computer's owner or a pod admin act (`loadManageableMachine`)
 * and refuse a key. Revoke is governed (`checkPermissionOrPropose`): a
 * `proposed` answer means it waits for review and NOTHING was revoked yet,
 * and the page says exactly that.
 *
 * Rotation is not a button: a computer's new key can only reach the computer
 * through the device flow, so the page hands over the one line to run there.
 */

import { Button, Radio, RadioGroup, addToast } from "@heroui/react";
import { ArrowRight, Bot, KeyRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  isComputerBelongsTo,
  seenLine,
  type ComputerBelongsTo,
} from "@synap-core/types/computers";
import { resolveServiceName } from "@synap-core/types/service-marks";
import { humanizeToken } from "@synap-core/types/vocabulary";
import { trpc } from "../../../../lib/trpc";
import {
  formatDate,
  formatRelative,
  readableError,
  shortId,
} from "../../../../lib/format";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { writeModeLabel } from "../../../../lib/agent-writes/agent-writes";
import { useT } from "../../../../lib/i18n/locale-provider";
import { navHref } from "../../../../lib/console-nav";
import { CommandLine } from "../../../_lib/command-line";
import type { DangerAction } from "../../../_lib/object/danger-zone";
import {
  loadFailure,
  notFound,
  type FailureWording,
} from "../../../_lib/object/load-failure";
import { SubjectActivity } from "../../../_lib/object/subject-activity";
import {
  useSetMachineBelongsTo,
  useSetMachineRunsScripts,
  useSetMachineWakesAgents,
} from "../../../_lib/presence/use-sensitive-actions";
import type { ObjectFrame } from "../../../_lib/object/views/object-frame";
import { ResourceRow, ResourceRowEmpty } from "../../components/resource-row";
import { SectionCard } from "../../components/section-card";
import { ConfirmModal } from "../../components/confirm-modal";
import {
  ComputerKeyLifetimeModal,
  RenameComputerModal,
} from "./computer-modals";
import { ComputerWrites, useAgentsOnComputer } from "./computer-writes-section";
import { agentModeOnComputer } from "./computer-writes";
import { en, fr } from "./copy";
import {
  RECONNECT_COMMAND,
  activityLine,
  belongsToChangeNeedsConfirm,
  belongsToChoices,
  belongsToMark,
  computerSummary,
  days,
  keyLifetimeLine,
  keyStatus,
  keysOnComputer,
  leaveAgentsConfirm,
  ownerWords,
  platformLabel,
  revokeImpact,
  revokeLine,
  scriptsOwnerWords,
  seedsRevokedLine,
  type ComputerLike,
} from "./computer-model";

const CATALOGS = { en, fr };

/** Agents the Overview previews before "Show all N agents". */
const AGENTS_PREVIEW = 3;

/**
 * A computer has no page in the Synap app — this one is the only one — so a
 * failed read never offers to open it there.
 */
const NOT_IN_APP: FailureWording = { inApp: false };

/** What the viewer may follow from this page (admin pages link out more). */
export interface ComputerLinks {
  /** An agent's row on the Agents page. */
  agentHref?: (agentId: string) => string;
  /** A key's row on the Keys page. */
  keyHref?: (keyId: string) => string;
  /** The owner's row on the Members page. */
  ownerHref?: (userId: string) => string;
}

export function ComputerObject({
  id,
  computer,
  isLoading,
  error,
  frame,
  viewerId,
  links,
  podDefaultDays,
}: {
  id: string;
  /** The loaded row; undefined while loading, null when it is not there. */
  computer: ComputerLike | null | undefined;
  isLoading: boolean;
  error: { data?: { code?: string | null } | null } | null;
  frame: ObjectFrame;
  viewerId: string | null;
  links: ComputerLinks;
  /** The pod default lifetime, when the viewer may read it. */
  podDefaultDays?: number | null;
}) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [dialog, setDialog] = useState<null | "rename" | "lifetime">(null);
  const [proposalId, setProposalId] = useState<string | null>(null);
  // Leaving "An agent's" waits here for its confirm (it takes approvals back).
  const [leaveAgents, setLeaveAgents] = useState<ComputerBelongsTo | null>(
    null
  );
  const scripts = computer ? scriptsOwnerWords(computer, viewerId) : null;
  // "Wakes agents" (plan v2 slice 4): a sensitive action, like Runs scripts.
  const wakesAgents = useSetMachineWakesAgents({
    onSuccess: async (out) => {
      addToast({
        title:
          out.status === "proposed"
            ? "Waiting for review. Nothing changed yet."
            : out.wakesAgents
              ? "This computer now wakes its agents"
              : "This computer no longer wakes its agents",
        color: "default",
      });
      await utils.machines.invalidate();
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        title: "Couldn't change this",
        description: readableError(err.message) ?? "Try again.",
        color: "danger",
      });
    },
  });
  // With the proof of presence (W3 slice 3): a sensitive action.
  const runsScripts = useSetMachineRunsScripts({
    onSuccess: async (out) => {
      const whose = scripts?.whose ?? "its owner's";
      addToast({
        title:
          out.status === "proposed"
            ? "Waiting for review. Nothing changed yet."
            : out.runsScripts
              ? `This computer now runs ${whose} scripts`
              : `This computer no longer runs ${whose} scripts`,
        color: "default",
      });
      await utils.machines.invalidate();
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        title: "Couldn't change this",
        description: readableError(err.message) ?? "Try again.",
        color: "danger",
      });
    },
  });
  const belongsTo = useSetMachineBelongsTo({
    onSuccess: async (out) => {
      addToast(
        out.status === "proposed"
          ? {
              title: "Waiting for review. Nothing changed yet.",
              color: "default",
            }
          : {
              title: `${computer?.name ?? "This computer"}: ${belongsToMark(out) ?? ""}`,
              description: seedsRevokedLine(out.seedsRevoked) ?? undefined,
              color: "default",
            }
      );
      await utils.machines.invalidate();
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        title: "Couldn't change this",
        description: readableError(err.message) ?? "Try again.",
        color: "danger",
      });
    },
  });
  const revoke = trpc.machines.revoke.useMutation({
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        title: "Couldn't revoke this computer",
        description: readableError(err.message) ?? "Try again.",
        color: "danger",
      });
    },
  });

  if (isLoading) return frame.loading("Loading computer…");
  if (!computer) {
    // No error and no row: the list loaded and this computer is not in it.
    return frame.failure({
      kind: "machine",
      id,
      failure:
        loadFailure(error, "Computer", NOT_IN_APP) ??
        notFound("Computer", NOT_IN_APP),
      openIn: false,
    });
  }

  const c = computer;
  const owner = ownerWords(c, viewerId);
  const words = scriptsOwnerWords(c, viewerId);
  const impact = revokeImpact(c);
  const revoking = revoke.isPending;
  const revoked = c.key?.state === "revoked";
  const keys = keysOnComputer(c);
  const whose = belongsToMark(c);

  const danger: DangerAction[] = revoked
    ? []
    : [
        {
          key: "revoke",
          label: "Revoke this computer",
          description: revokeLine(c),
          confirmLabel: "Revoke computer",
          isPending: revoking,
          consequence: (
            <>
              <p>
                {impact.liveKeys > 0
                  ? `Every key on ${c.name} stops working now — ${impact.liveKeys} live (its own and its agents'),`
                  : `${c.name} holds no live key, so nothing stops working now,`}{" "}
                and{" "}
                {impact.agents > 0
                  ? `${impact.agents} agent${impact.agents === 1 ? "" : "s"} running on it ${impact.agents === 1 ? "is" : "are"} disconnected.`
                  : "no agent on it is connected."}
              </p>
              <p className="mt-2">
                The computer and its agents stay listed with their history.
                Running <code className="font-mono">{RECONNECT_COMMAND}</code>{" "}
                on it connects it again.
              </p>
              <p className="mt-2">
                If revoking needs a review on this pod, it waits for one and
                nothing is revoked until it is approved.
              </p>
            </>
          ),
          onConfirm: async () => {
            const res = await revoke.mutateAsync({ machineId: c.id });
            // Its keys and its agents' keys stop: the Keys list reads them too.
            await Promise.all([
              utils.machines.invalidate(),
              utils.agentUsers.list.invalidate(),
              utils.apiKeys.invalidate(),
            ]);
            if (res.status === "proposed") {
              setProposalId(res.proposalId);
              addToast({
                title: "Sent for review",
                description: "Nothing is revoked until it is approved.",
                color: "default",
              });
              return;
            }
            addToast({
              title: "Computer revoked",
              description: `${res.revokedKeys} key${res.revokedKeys === 1 ? "" : "s"} stopped working.`,
              color: "default",
            });
          },
        },
      ];

  return (
    <>
      {frame.object({
        header: {
          kind: "machine",
          title: c.name,
          summary: computerSummary(c, viewerId, (d) => formatRelative(d)),
          status: keyStatus(c.key, Date.now(), { withDetail: true }),
          breadcrumb: frame.breadcrumb?.(c.name),
          primaryAction: (
            <Button
              size="sm"
              radius="md"
              variant="flat"
              color="primary"
              onPress={() => setDialog("rename")}
            >
              Rename
            </Button>
          ),
          secondaryActions: revoked ? undefined : (
            <Button
              size="sm"
              radius="md"
              variant="flat"
              onPress={() => setDialog("lifetime")}
            >
              Change key lifetime
            </Button>
          ),
        },
        facts: [
          ...(c.hostname
            ? [{ label: "Hostname", value: c.hostname, mono: true }]
            : []),
          ...(platformLabel(c.platform)
            ? [{ label: "Platform", value: platformLabel(c.platform) }]
            : []),
          ...(owner
            ? [
                {
                  label: "Owner",
                  value:
                    c.owner && links.ownerHref ? (
                      <Link
                        href={links.ownerHref(c.owner.id)}
                        className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 hover:underline"
                      >
                        {capitalize(owner)}
                      </Link>
                    ) : (
                      capitalize(owner)
                    ),
                },
              ]
            : []),
          ...(whose ? [{ label: "Whose it is", value: whose }] : []),
          { label: "Created", value: formatDate(c.createdAt) },
          { label: "Key lifetime", value: keyLifetimeLine(c) },
        ],
        factColumns: 3,
        children: proposalId ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-status-stale/10 px-3 py-2.5 ring-1 ring-inset ring-status-stale/30">
            <p className="min-w-0 flex-1 text-[12.5px] text-foreground">
              Revoking {c.name} is waiting for review. Nothing has been revoked
              yet.
            </p>
            <Button
              as={Link}
              href={navHref("review", { focus: proposalId })}
              size="sm"
              variant="flat"
              radius="md"
              endContent={<ArrowRight className="h-3.5 w-3.5" />}
            >
              Open in Review
            </Button>
          </div>
        ) : undefined,
        tabs: [
          {
            key: "overview",
            label: "Overview",
            content: (
              <div className="flex flex-col gap-5">
                <SectionCard
                  title="Agents on this computer"
                  actions={
                    c.agents.length > AGENTS_PREVIEW ? (
                      <Link
                        href="?tab=agents"
                        scroll={false}
                        className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 text-[12px] text-foreground/65 hover:text-foreground hover:underline"
                      >
                        Show all {c.agents.length} agents
                      </Link>
                    ) : undefined
                  }
                >
                  <AgentRows
                    computer={c}
                    limit={AGENTS_PREVIEW}
                    agentHref={links.agentHref}
                  />
                </SectionCard>
                {!revoked && <ComputerWrites computer={c} />}
                {!revoked && (
                  <SectionCard title="Runs scripts">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="min-w-0 flex-1 text-[12.5px] text-foreground/75">
                        {c.runsScripts
                          ? `${c.name} picks up the scripts ${words.approves} and runs each one in a fresh box, with no access to the pod. Their logs and files come back on the run.`
                          : `Let ${c.name} run the scripts ${words.approves} (Python or Node with packages), each in a fresh box with no access to the pod. Its runner must be installed on it.`}
                      </p>
                      <Button
                        size="sm"
                        radius="md"
                        variant="flat"
                        isLoading={runsScripts.isPending}
                        onPress={() =>
                          runsScripts.mutate({
                            machineId: c.id,
                            enabled: !c.runsScripts,
                          })
                        }
                      >
                        {c.runsScripts
                          ? "Stop running scripts"
                          : words.whose === "your"
                            ? "Run my scripts here"
                            : `Run ${words.whose} scripts here`}
                      </Button>
                    </div>
                  </SectionCard>
                )}
                {!revoked && (
                  <SectionCard title="Wakes agents">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="min-w-0 flex-1 text-[12.5px] text-foreground/75">
                        {c.wakesAgents
                          ? c.waker?.online
                            ? `${c.name} starts its agents when work is handed to them. Its waker is running.`
                            : `${c.name} starts its agents when work is handed to them, once its waker runs: \`synap waker install\` on it.`
                          : `Let ${c.name} start its agents when work is handed to them, without a terminal open. Its waker must be installed on it: \`synap waker install\`.`}
                      </p>
                      <Button
                        size="sm"
                        radius="md"
                        variant="flat"
                        isLoading={wakesAgents.isPending}
                        onPress={() =>
                          wakesAgents.mutate({
                            machineId: c.id,
                            enabled: !c.wakesAgents,
                          })
                        }
                      >
                        {c.wakesAgents
                          ? "Stop waking agents"
                          : "Wake agents here"}
                      </Button>
                    </div>
                  </SectionCard>
                )}
                {/* 0388: set at approval, changed only here. A row from
                    before it (no `belongsTo`) shows the choices with none
                    selected: never a guessed answer, never a hidden door. */}
                {!revoked && (
                  <SectionCard title="Whose computer it is">
                    {!c.belongsTo && (
                      <p className="mb-2 text-[12.5px] text-foreground/65">
                        Not set yet. Choose one.
                      </p>
                    )}
                    <RadioGroup
                      aria-label="Whose computer it is"
                      size="sm"
                      value={c.belongsTo ?? null}
                      isDisabled={belongsTo.isPending}
                      onValueChange={(v) => {
                        if (!isComputerBelongsTo(v) || v === c.belongsTo)
                          return;
                        if (belongsToChangeNeedsConfirm(c.belongsTo, v))
                          setLeaveAgents(v);
                        else
                          belongsTo.mutate({ machineId: c.id, belongsTo: v });
                      }}
                    >
                      {belongsToChoices().map((choice) => (
                        <Radio
                          key={choice.value}
                          value={choice.value}
                          description={choice.line}
                        >
                          {choice.label}
                        </Radio>
                      ))}
                    </RadioGroup>
                    {leaveAgents && (
                      <ConfirmModal
                        isOpen
                        onClose={() => setLeaveAgents(null)}
                        onConfirm={() => {
                          setLeaveAgents(null);
                          belongsTo.mutate({
                            machineId: c.id,
                            belongsTo: leaveAgents,
                          });
                        }}
                        {...leaveAgentsConfirm(c.name, leaveAgents)}
                        confirmColor="danger"
                      />
                    )}
                  </SectionCard>
                )}
                <SectionCard
                  title="Keys on this computer"
                  hint={
                    keys.length > 0
                      ? `${keys.length} key${keys.length === 1 ? "" : "s"}`
                      : undefined
                  }
                >
                  {keys.length === 0 ? (
                    <ResourceRowEmpty message="It holds no key." />
                  ) : (
                    <div className="-mx-2 divide-y divide-foreground/[0.05]">
                      {keys.map((k) => (
                        <ResourceRow
                          key={k.key.id}
                          Icon={KeyRound}
                          primary={k.own ? "Computer key" : k.holderName}
                          secondary={[
                            shortId(k.key.id),
                            k.key.expiresAt
                              ? `expires ${formatDate(k.key.expiresAt)}`
                              : "no expiry",
                          ].join(" · ")}
                          status={keyStatus(k.key)}
                          onSelect={
                            links.keyHref
                              ? () => router.push(links.keyHref!(k.key.id))
                              : undefined
                          }
                        />
                      ))}
                    </div>
                  )}
                </SectionCard>
                <SectionCard
                  title={
                    revoked ? "Connect it again" : "Reconnect or rotate keys"
                  }
                >
                  <div className="flex flex-col gap-2">
                    <p className="text-[12.5px] leading-relaxed text-foreground/65">
                      {revoked
                        ? `Run this on ${c.name} to connect it again. You approve it in the browser.`
                        : `Run this on ${c.name} to replace its keys. Its agents keep running; the old keys stop working once the new ones are in use.`}
                    </p>
                    <CommandLine command={RECONNECT_COMMAND} />
                    <p className="text-[12px] text-foreground/65">
                      New keys last {days(c.effectiveKeyTtlDays)}.
                    </p>
                  </div>
                </SectionCard>
              </div>
            ),
          },
          {
            key: "agents",
            label: `Agents (${c.agents.length})`,
            content: (
              <SectionCard title="Agents on this computer">
                <AgentRows computer={c} agentHref={links.agentHref} />
              </SectionCard>
            ),
          },
          {
            key: "activity",
            label: "Activity",
            content: (
              <SubjectActivity
                subjectIds={[c.id]}
                line={(e) => activityLine(e, humanizeToken, words.whose)}
              />
            ),
          },
        ],
        advanced: {
          ids: [
            { label: "Computer id", value: c.id },
            ...(c.key ? [{ label: "Key id", value: c.key.id }] : []),
          ],
          raw: c,
        },
        danger,
      })}
      {dialog === "rename" && (
        <RenameComputerModal computer={c} onClose={() => setDialog(null)} />
      )}
      {dialog === "lifetime" && (
        <ComputerKeyLifetimeModal
          computer={c}
          podDefaultDays={podDefaultDays}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}

function AgentRows({
  computer,
  limit,
  agentHref,
}: {
  computer: ComputerLike;
  limit?: number;
  agentHref?: (agentId: string) => string;
}) {
  const router = useRouter();
  const t = useT(CATALOGS);
  // What each agent's writes really follow (the stricter of it and this
  // computer), as a mark on its row; nothing while it is unread.
  const writes = useAgentsOnComputer(computer);
  const modeMark = (agentId: string): string | null => {
    const read = writes.byId.get(agentId);
    if (!read)
      return writes.failedIds.has(agentId) ? t("agent.mode.failed") : null;
    const { mode, source } = agentModeOnComputer(read);
    const label = writeModeLabel(mode);
    return source === "computer"
      ? t("agent.mode.computer", { mode: label })
      : source === "agent"
        ? t("agent.mode.agent", { mode: label })
        : t("agent.mode.podDefault", { mode: label });
  };
  if (computer.agents.length === 0)
    return (
      <ResourceRowEmpty message="No agent runs on it. Agents set up with this computer appear here." />
    );
  const shown =
    limit === undefined ? computer.agents : computer.agents.slice(0, limit);
  return (
    <div className="-mx-2 divide-y divide-foreground/[0.05]">
      {shown.map((a) => (
        <ResourceRow
          key={a.id}
          Icon={Bot}
          primary={a.name}
          secondary={[
            serviceOf(a),
            seenLine(a.lastSeenAt, (d) => formatRelative(d)),
            modeMark(a.id),
          ]
            .filter(Boolean)
            .join(" · ")}
          status={keyStatus(a.key)}
          onSelect={agentHref ? () => router.push(agentHref(a.id)) : undefined}
        />
      ))}
    </div>
  );
}

/**
 * What runs the agent, by the service-name door ("Claude Code"); left out
 * when it only repeats the agent's name.
 */
function serviceOf(a: ComputerLike["agents"][number]): string | null {
  if (!a.agentType) return null;
  const service = resolveServiceName(a.agentType);
  return service.trim().toLowerCase() === a.name.trim().toLowerCase()
    ? null
    : service;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

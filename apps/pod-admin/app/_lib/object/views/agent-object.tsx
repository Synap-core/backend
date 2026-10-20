"use client";

/**
 * One agent, the one body — drawn by `/open/agent/:id` as an object page in
 * the receiver card (`AgentObject`) and by the console's agent drawer
 * (`AgentDrawer`, opened from Agents). Both draw the same sections: where it
 * stands, its scorecard, how its writes land, and what the viewer may do to it.
 *
 *   • Facts — the roster row (`agentUsers.list`, floored to the viewer: an
 *     agent in a space the viewer cannot see is not on it).
 *   • Scorecard — `diagnose.agent`, readable by the agent's OWNER or a pod
 *     admin (the pod's agent read floor). Anyone else is told who can read it
 *     rather than shown an empty card.
 *   • Governance — `agentUsers.governance`: the one sentence every surface
 *     shows, plus the per-space ask-first overrides the viewer can see.
 *   • Disconnect — `agentUsers.disconnect` revokes every live and pending key
 *     (offered when the pod says the viewer may: `viewerCanDisconnect`); the
 *     agent stays listed and `synap init` reconnects it.
 *   • Remove — `agentUsers.removeByUserId(creatorId)` deletes EVERY agent that
 *     person created (it is keyed on the creator, not on one agent), so the
 *     confirm names each one the viewer can see. Pod admins only.
 *
 * On the web page an agent the roster does not list (a pod admin reading a
 * member's agent in a space the admin is not in) still has its scorecard: the
 * page then names it from the scorecard and says the rest is not visible.
 */

import { Button, addToast } from "@heroui/react";
import { Plug, Trash2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { resolveAgentReachMark } from "@synap-core/types/agents";
import { humanizeToken } from "@synap-core/types/vocabulary";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { formatRelative } from "../../../../lib/format";
import { ExitLink } from "../../../../lib/exit-link";
import { openIn } from "../../../../lib/open-in";
import { ConfirmModal } from "../../../(admin)/components/confirm-modal";
import {
  agentReviewHref,
  agentsByCreator,
  buildAgentRoster,
  hostComputerHref,
  keyCountsLine,
  originLine,
  reachErrorSentence,
  type AgentRowView,
} from "../../../(admin)/agents/_lib/agent-roster";
import { FactsGrid, type Fact } from "../facts-grid";
import { couldNotLoad, loadFailure, notFound } from "../load-failure";
import { useReauthOnUnauthorized } from "../use-reauth";
import type { ObjectFrame } from "./object-frame";

/** Names a person by id: "You", their name from the pod's members, or null. */
export type OwnerName = (userId: string | null | undefined) => string | null;

/** The viewer's id and the `OwnerName` reader both agent frames use. */
export function useAgentPeople(): {
  viewerId: string | null;
  ownerName: OwnerName;
} {
  const me = trpc.users.me.useQuery(undefined, { staleTime: 300_000 });
  const members = trpc.workspaces.listPodMembers.useQuery(undefined, {
    staleTime: 60_000,
  });
  const viewerId = me.data?.id ?? null;
  const ownerName = useMemo(() => {
    const byId = new Map(
      (members.data ?? []).map((m) => [m.id, m.name ?? m.email])
    );
    return (userId: string | null | undefined): string | null => {
      if (!userId) return null;
      if (userId === viewerId) return "You";
      return byId.get(userId) ?? null;
    };
  }, [members.data, viewerId]);
  return { viewerId, ownerName };
}

/** A titled block of the agent body. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[12px] font-medium text-foreground">{title}</h3>
      {children}
    </section>
  );
}

// ─── Facts ──────────────────────────────────────────────────────────

export function agentFacts(view: AgentRowView, ownerName: OwnerName): Fact[] {
  const row = view.row;
  const reach = resolveAgentReachMark(row);
  const origin = originLine(row.origin);
  const owner = ownerName(row.createdByUserId);
  const computerHref = hostComputerHref(row);
  return [
    ...(owner ? [{ label: "Answers to", value: owner }] : []),
    ...(origin ? [{ label: "Came from", value: origin }] : []),
    // The computer it runs on is the object; the key's host label is only
    // the fallback for an agent that is not on one.
    ...(row.hostComputer && computerHref
      ? [
          {
            label: "Runs on",
            value: (
              <Link
                href={computerHref}
                className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                {row.hostComputer.name}
              </Link>
            ),
          },
        ]
      : view.mark.host
        ? [{ label: "Last machine", value: view.mark.host, mono: true }]
        : []),
    { label: "Keys", value: keyCountsLine(row) },
    ...(reach
      ? [
          {
            label: "Reach",
            value: reach.error ? (
              <span className="text-status-down">
                {reach.label} — {reachErrorSentence(reach.error.code)}
              </span>
            ) : (
              reach.label
            ),
          },
        ]
      : []),
    ...(row.operatedByViewer
      ? [{ label: "Acts for", value: "You — it can see and pick up your work" }]
      : []),
  ];
}

/** The facts as a drawer section. */
export function AgentFactsSection({
  view,
  ownerName,
}: {
  view: AgentRowView;
  ownerName: OwnerName;
}) {
  return (
    <Section title="About">
      <FactsGrid facts={agentFacts(view, ownerName)} columns={2} />
    </Section>
  );
}

// ─── Scorecard ──────────────────────────────────────────────────────

function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/**
 * The agent's scorecard. `readable` is the pod's read floor as the viewer
 * meets it (owner or pod admin): only then is it asked for.
 */
export function AgentScorecard({
  agentId,
  readable,
  ownerId,
  ownerName,
}: {
  agentId: string;
  readable: boolean;
  ownerId: string | null | undefined;
  ownerName: OwnerName;
}) {
  const card = trpc.diagnose.agent.useQuery(
    { agentId },
    { enabled: readable, staleTime: 60_000 }
  );

  if (!readable) {
    const owner = ownerName(ownerId);
    return (
      <Section title="Scorecard">
        <p className="text-[12.5px] text-foreground/65">
          {owner
            ? `Only the agent's owner (${owner}) or a pod admin can see its scorecard.`
            : "Only the agent's owner or a pod admin can see its scorecard."}
        </p>
      </Section>
    );
  }

  if (card.isLoading) {
    return (
      <Section title="Scorecard">
        <div className="h-16 rounded-lg bg-foreground/[0.04] shimmer-pulse" />
      </Section>
    );
  }
  if (card.isError || !card.data || "error" in card.data) {
    return (
      <Section title="Scorecard">
        <div className="flex items-center gap-3">
          <p className="text-[12.5px] text-status-down">
            Couldn&apos;t load the scorecard.
          </p>
          <Button
            size="sm"
            variant="flat"
            radius="md"
            onPress={() => void card.refetch()}
          >
            Retry
          </Button>
        </div>
      </Section>
    );
  }

  const s = card.data;
  if (s.counts.total === 0) {
    return (
      <Section title="Scorecard">
        <p className="text-[12.5px] text-foreground/65">
          It has not proposed a change you can see yet.
        </p>
      </Section>
    );
  }
  return (
    <Section title="Scorecard">
      <p className="text-[12.5px] text-foreground">
        {percent(s.rates.approveRate)} of its last {s.counts.total} changes were
        approved, {percent(s.rates.rejectRate)} refused.
      </p>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Approved" value={s.counts.approved} />
        <Stat label="Refused" value={s.counts.rejected} />
        <Stat label="Waiting" value={s.counts.pending} />
        <Stat label="Edited first" value={s.counts.revised} />
      </dl>
      {s.rejectionReasons.length > 0 && (
        <p className="text-[12px] text-foreground/65">
          Most refused for:{" "}
          {s.rejectionReasons
            .slice(0, 3)
            .map((r) => `${r.reason} (${r.count})`)
            .join(", ")}
        </p>
      )}
      <p
        className={`text-[12px] ${s.dailyCap.atOrOverCap ? "text-status-stale" : "text-foreground/65"}`}
      >
        {s.dailyCap.pendingCount} of {s.dailyCap.cap} proposals waiting today
        {s.dailyCap.atOrOverCap ? " — at its daily cap." : "."}
      </p>
    </Section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-foreground/[0.04] px-3 py-2">
      <dt className="text-[11px] text-foreground/65">{label}</dt>
      <dd className="tabular text-[15px] font-medium text-foreground">
        {value.toLocaleString()}
      </dd>
    </div>
  );
}

// ─── Governance ─────────────────────────────────────────────────────

export function AgentGovernance({ agentUserId }: { agentUserId: string }) {
  const gov = trpc.agentUsers.governance.useQuery(
    { agentUserId },
    { staleTime: 60_000, retry: false }
  );
  return (
    <Section title="How its writes land">
      {gov.isLoading ? (
        <div className="h-10 rounded-lg bg-foreground/[0.04] shimmer-pulse" />
      ) : gov.error?.data?.code === "NOT_FOUND" ? (
        // The door answers NOT_FOUND to anyone the agent does not answer to.
        <p className="text-[12.5px] text-foreground/65">
          Only its owner, the people it works for, or a pod admin can see how
          its writes land.
        </p>
      ) : gov.isError || !gov.data ? (
        <div className="flex items-center gap-3">
          <p className="text-[12.5px] text-status-down">
            Couldn&apos;t load its governance.
          </p>
          <Button
            size="sm"
            variant="flat"
            radius="md"
            onPress={() => void gov.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : (
        <>
          <p className="text-[12.5px] text-foreground">{gov.data.line}</p>
          {gov.data.postures.spaces.length > 0 && (
            <ul className="flex flex-col gap-1 text-[12px] text-foreground/65">
              {gov.data.postures.spaces.map((sp) => (
                <li key={sp.workspaceId}>
                  In {sp.name}:{" "}
                  {sp.posture === "ask-first"
                    ? "every change asks first"
                    : sp.posture
                      ? humanizeToken(sp.posture)
                      : "follows the pod default"}
                </li>
              ))}
            </ul>
          )}
          <p className="text-[12px] text-foreground/65">
            Change it from the desktop app, in Settings › Agents.
          </p>
        </>
      )}
    </Section>
  );
}

// ─── Actions ────────────────────────────────────────────────────────

export function AgentActions({
  view,
  roster,
  viewerId,
  viewerIsPodAdmin,
  ownerName,
  onRemoved,
}: {
  view: AgentRowView;
  roster: readonly AgentRowView[];
  viewerId: string | null;
  /** Remove is pod-admin only (`removeByUserId`); offered to admins only. */
  viewerIsPodAdmin: boolean;
  ownerName: OwnerName;
  onRemoved: () => void;
}) {
  const utils = trpc.useUtils();
  const row = view.row;
  const [confirm, setConfirm] = useState<null | "disconnect" | "remove">(null);

  const disconnect = trpc.agentUsers.disconnect.useMutation({
    onSuccess: (res) => {
      void utils.agentUsers.list.invalidate();
      void utils.apiKeys.adminListAll.invalidate();
      addToast({
        title: "Agent disconnected",
        description: `${res.revokedCount} key${res.revokedCount === 1 ? "" : "s"} revoked.`,
        color: "default",
      });
      setConfirm(null);
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        title: "Disconnect failed",
        description: err.message,
        color: "danger",
      });
    },
  });

  const remove = trpc.agentUsers.removeByUserId.useMutation({
    onSuccess: (res) => {
      void utils.agentUsers.list.invalidate();
      void utils.diagnose.agents.invalidate();
      void utils.apiKeys.adminListAll.invalidate();
      addToast({
        title: res.removedCount === 1 ? "Agent removed" : "Agents removed",
        description: `Removed ${res.removedCount} agent${res.removedCount === 1 ? "" : "s"} and revoked ${res.revokedKeyCount} key${res.revokedKeyCount === 1 ? "" : "s"}.`,
        color: "default",
      });
      setConfirm(null);
      onRemoved();
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        title: "Remove failed",
        description: err.message,
        color: "danger",
      });
    },
  });

  const creatorId = row.createdByUserId ?? null;
  // The pod refuses removing your own agents through this admin door.
  const canRemove = viewerIsPodAdmin && !!creatorId && creatorId !== viewerId;
  const siblings = creatorId
    ? agentsByCreator(
        roster.map((v) => v.row),
        creatorId
      )
    : [];
  const creator = ownerName(creatorId) ?? "this person";
  const live = row.activeKeys ?? 0;
  const pending = row.pendingKeys ?? 0;

  if (!view.mark.canDisconnect && !canRemove) return null;

  return (
    <Section title="Actions">
      <div className="flex flex-col gap-2">
        {view.mark.canDisconnect && (
          <Button
            variant="flat"
            size="sm"
            radius="md"
            color="danger"
            startContent={<Plug className="h-3.5 w-3.5" />}
            className="justify-start text-[12.5px]"
            onPress={() => setConfirm("disconnect")}
          >
            Disconnect
          </Button>
        )}
        {canRemove && (
          <Button
            variant="flat"
            size="sm"
            radius="md"
            color="danger"
            startContent={<Trash2 className="h-3.5 w-3.5" />}
            className="justify-start text-[12.5px]"
            onPress={() => setConfirm("remove")}
          >
            {siblings.length > 1
              ? `Remove all ${siblings.length} agents ${creator} created`
              : "Remove agent"}
          </Button>
        )}
      </div>

      <ConfirmModal
        isOpen={confirm === "disconnect"}
        onClose={() => setConfirm(null)}
        onConfirm={() => disconnect.mutate({ agentUserId: row.id })}
        title={`Disconnect ${row.name ?? "this agent"}?`}
        consequence={
          <>
            <p>
              Revokes every key it holds ({live} live
              {pending > 0 ? `, ${pending} waiting` : ""}). It stops reaching
              the pod immediately.
            </p>
            <p className="mt-2">
              The agent stays listed with its history and governance. Running{" "}
              <code>synap init</code> on its computer again connects it with a
              fresh key.
            </p>
          </>
        }
        confirmLabel="Disconnect"
        isPending={disconnect.isPending}
      />

      <ConfirmModal
        isOpen={confirm === "remove"}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          if (creatorId) remove.mutate({ userId: creatorId });
        }}
        title={
          siblings.length > 1
            ? `Remove every agent ${creator} created?`
            : `Remove ${row.name ?? "this agent"}?`
        }
        consequence={
          <>
            <p>
              This removes agents by who created them, not one at a time: every
              agent {creator} created goes, its keys are revoked and its space
              memberships dropped. It cannot be undone.
            </p>
            <p className="mt-2">
              {siblings.length > 1 ? "Including: " : "That is: "}
              {siblings.map((s) => s.name ?? s.id).join(", ")}
              {". "}
              Agents in spaces you cannot see are removed too, and so are the
              computers {creator} connected (listed under Computers).
            </p>
            <p className="mt-2">
              Data these agents already wrote stays on the pod — this removes
              the identities, not their work.
            </p>
          </>
        }
        confirmLabel={siblings.length > 1 ? "Remove all" : "Remove agent"}
        isPending={remove.isPending}
      />
    </Section>
  );
}

// ─── The object page ────────────────────────────────────────────────

/** The agent as an object page (the web `/open/agent/:id`). */
export function AgentObject({
  id,
  frame,
  viewerIsPodAdmin,
  onRemoved,
}: {
  id: string;
  frame: ObjectFrame;
  viewerIsPodAdmin: boolean;
  /** After its creator's agents were removed (the page no longer applies). */
  onRemoved: () => void;
}) {
  const list = trpc.agentUsers.list.useQuery({}, { staleTime: 30_000 });
  const { viewerId, ownerName } = useAgentPeople();
  const roster = useMemo(
    () =>
      buildAgentRoster(list.data ?? [], [], viewerId, (iso) =>
        formatRelative(iso)
      ),
    [list.data, viewerId]
  );
  const view = roster.find((v) => v.row.id === id) ?? null;
  // Off the roster, the scorecard is the one read that can still name it —
  // and only for those the pod lets read it.
  const card = trpc.diagnose.agent.useQuery(
    { agentId: id },
    { enabled: list.isSuccess && !view, retry: false }
  );
  useReauthOnUnauthorized(list.error, card.error);

  if (list.isLoading || (!view && card.isLoading)) {
    return frame.loading("Loading agent…");
  }
  const listFail = loadFailure(list.error, "Agent");
  if (listFail) return frame.failure({ kind: "agent", id, failure: listFail });

  const openInApp = (
    <ExitLink
      exit={openIn({ kind: "objectInApp", objectKind: "agent", id })}
      label="Open in app"
    />
  );

  if (!view) {
    const scorecard = card.data && !("error" in card.data) ? card.data : null;
    if (!scorecard) {
      return frame.failure({
        kind: "agent",
        id,
        failure:
          loadFailure(card.error, "Agent") ??
          (card.data ? notFound("Agent") : couldNotLoad("Agent")),
      });
    }
    const title = scorecard.agentName ?? "Agent";
    return frame.object({
      header: {
        kind: "agent",
        title,
        summary:
          "It works in spaces you are not in, so only its scorecard and governance show here.",
        breadcrumb: frame.breadcrumb?.(title),
        secondaryActions: openInApp,
      },
      children: (
        <div className="flex flex-col gap-5">
          <AgentScorecard
            agentId={id}
            readable
            ownerId={null}
            ownerName={ownerName}
          />
          <AgentGovernance agentUserId={id} />
        </div>
      ),
      advanced: { ids: [{ label: "Agent id", value: id }] },
    });
  }

  const row = view.row;
  const title = row.name ?? row.email ?? "Agent";
  return frame.object({
    header: {
      kind: "agent",
      title,
      summary: view.sentence,
      status: view.status,
      breadcrumb: frame.breadcrumb?.(title),
      primaryAction: view.needsReview ? (
        <Button
          as={Link}
          href={agentReviewHref(row)}
          size="sm"
          radius="md"
          variant="flat"
        >
          Decide in Review
        </Button>
      ) : undefined,
      secondaryActions: openInApp,
    },
    facts: agentFacts(view, ownerName),
    children: (
      <div className="flex flex-col gap-5">
        <AgentScorecard
          agentId={row.id}
          readable={view.ownedByViewer || viewerIsPodAdmin}
          ownerId={row.createdByUserId}
          ownerName={ownerName}
        />
        <AgentGovernance agentUserId={row.id} />
        <AgentActions
          view={view}
          roster={roster}
          viewerId={viewerId}
          viewerIsPodAdmin={viewerIsPodAdmin}
          ownerName={ownerName}
          onRemoved={onRemoved}
        />
      </div>
    ),
    advanced: {
      ids: [
        { label: "Agent id", value: row.id },
        ...(row.createdByUserId
          ? [{ label: "Owner id", value: row.createdByUserId }]
          : []),
      ],
    },
  });
}

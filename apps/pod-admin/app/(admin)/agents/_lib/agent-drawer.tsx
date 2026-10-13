"use client";

/**
 * One agent's detail: where it stands, its scorecard, how its writes land,
 * and the two things an admin can do to it.
 *
 *   • Scorecard — `diagnose.agent`, which the pod floors to the agent's OWNER
 *     (bug 6 in POD-ADMIN-CONSOLE-DECISIONS.md). It is only asked for when the
 *     viewer owns the agent; otherwise the drawer says why it is missing
 *     rather than rendering an empty card.
 *   • Governance — `agentUsers.governance`: the one sentence every surface
 *     shows, plus the per-space ask-first overrides the viewer can see.
 *   • Disconnect — `agentUsers.disconnect` revokes every live and pending key;
 *     the agent stays listed and `synap init` reconnects it.
 *   • Remove — `agentUsers.removeByUserId(creatorId)` deletes EVERY agent that
 *     person created (it is keyed on the creator, not on one agent), so the
 *     confirm names each one the viewer can see.
 */

import { Button, addToast } from "@heroui/react";
import { Bot, Plug, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { resolveAgentReachMark } from "@synap-core/types/agents";
import { humanizeToken } from "@synap-core/types/vocabulary";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { ConfirmModal } from "../../components/confirm-modal";
import { DetailDrawer } from "../../components/detail-drawer";
import { StatusPill } from "../../components/status-pill";
import { FactsGrid, type Fact } from "../../../_lib/object/facts-grid";
import {
  agentReviewHref,
  agentsByCreator,
  hostComputerHref,
  keyCountsLine,
  originLine,
  reachErrorSentence,
  type AgentRowView,
} from "./agent-roster";

export function AgentDrawer({
  view,
  roster,
  viewerId,
  ownerName,
  isOpen,
  onClose,
}: {
  view: AgentRowView | null;
  roster: readonly AgentRowView[];
  viewerId: string | null;
  ownerName: (userId: string | null | undefined) => string | null;
  isOpen: boolean;
  onClose: () => void;
}) {
  const row = view?.row;
  return (
    <DetailDrawer
      isOpen={isOpen}
      onClose={onClose}
      title={row?.name ?? row?.email ?? "Agent"}
      subtitle={row?.email ?? undefined}
      headerAccessory={
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-foreground/[0.06]">
          <Bot className="h-4 w-4 text-foreground/65" aria-hidden />
        </span>
      }
      headerRight={
        view ? (
          <StatusPill kind={view.status.kind} label={view.status.label} />
        ) : undefined
      }
    >
      {view && row ? (
        <div className="flex flex-col gap-5">
          <p className="text-[13px] text-foreground">{view.sentence}</p>
          {view.needsReview && (
            <Button
              as={Link}
              href={agentReviewHref(row)}
              size="sm"
              radius="md"
              variant="flat"
              className="min-h-10 self-start"
            >
              Decide in Review
            </Button>
          )}

          <Facts view={view} ownerName={ownerName} />
          <Scorecard view={view} ownerName={ownerName} />
          <Governance agentUserId={row.id} />
          <Actions
            view={view}
            roster={roster}
            viewerId={viewerId}
            ownerName={ownerName}
            onRemoved={onClose}
          />
        </div>
      ) : null}
    </DetailDrawer>
  );
}

// ─── Facts ──────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h4 className="text-[12px] font-medium text-foreground">{title}</h4>
      {children}
    </section>
  );
}

function Facts({
  view,
  ownerName,
}: {
  view: AgentRowView;
  ownerName: (userId: string | null | undefined) => string | null;
}) {
  const row = view.row;
  const reach = resolveAgentReachMark(row);
  const origin = originLine(row.origin);
  const owner = ownerName(row.createdByUserId);
  const computerHref = hostComputerHref(row);
  const facts: Fact[] = [
    ...(owner ? [{ label: "Answers to", value: owner }] : []),
    ...(origin ? [{ label: "Came from", value: origin }] : []),
    // The computer it runs on is the object; the key's host label is only
    // the fallback for an agent that is not on one.
    ...(row.hostComputer && computerHref
      ? [
          {
            label: "Runs on",
            value: (
              <Link href={computerHref} className="hover:underline">
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
  return (
    <Section title="About">
      <FactsGrid facts={facts} columns={2} />
    </Section>
  );
}

// ─── Scorecard ──────────────────────────────────────────────────────

function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function Scorecard({
  view,
  ownerName,
}: {
  view: AgentRowView;
  ownerName: (userId: string | null | undefined) => string | null;
}) {
  const card = trpc.diagnose.agent.useQuery(
    { agentId: view.row.id },
    { enabled: view.ownedByViewer, staleTime: 60_000 }
  );

  if (!view.ownedByViewer) {
    const owner = ownerName(view.row.createdByUserId);
    return (
      <Section title="Scorecard">
        <p className="text-[12.5px] text-foreground/65">
          {owner
            ? `Only the agent's owner can see its scorecard — ${owner} can open it in the desktop app.`
            : "Only the agent's owner can see its scorecard, and this pod does not record who owns this agent."}
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
          It has not proposed a change yet.
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

function Governance({ agentUserId }: { agentUserId: string }) {
  const gov = trpc.agentUsers.governance.useQuery(
    { agentUserId },
    { staleTime: 60_000 }
  );
  return (
    <Section title="How its writes land">
      {gov.isLoading ? (
        <div className="h-10 rounded-lg bg-foreground/[0.04] shimmer-pulse" />
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

function Actions({
  view,
  roster,
  viewerId,
  ownerName,
  onRemoved,
}: {
  view: AgentRowView;
  roster: readonly AgentRowView[];
  viewerId: string | null;
  ownerName: (userId: string | null | undefined) => string | null;
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
  const canRemove = !!creatorId && creatorId !== viewerId;
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

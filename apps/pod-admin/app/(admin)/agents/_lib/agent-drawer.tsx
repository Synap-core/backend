"use client";

/**
 * One agent's detail in a drawer over Agents. The sections are the shared
 * agent body (`app/_lib/object/views/agent-object.tsx`) that `/open/agent/:id`
 * draws as a page; this file is only the drawer frame around them. The
 * console is pod-admin only, so the scorecard is always readable here and
 * Remove is offered.
 */

import { Button } from "@heroui/react";
import { Bot } from "lucide-react";
import Link from "next/link";
import { DetailDrawer } from "../../components/detail-drawer";
import { StatusPill } from "../../components/status-pill";
import {
  AgentActions,
  AgentFactsSection,
  AgentGovernance,
  AgentScorecard,
  type OwnerName,
} from "../../../_lib/object/views/agent-object";
import { agentReviewHref, type AgentRowView } from "./agent-roster";

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
  ownerName: OwnerName;
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

          <AgentFactsSection view={view} ownerName={ownerName} />
          <AgentScorecard
            agentId={row.id}
            readable
            ownerId={row.createdByUserId}
            ownerName={ownerName}
          />
          <AgentGovernance agentUserId={row.id} />
          <AgentActions
            view={view}
            roster={roster}
            viewerId={viewerId}
            viewerIsPodAdmin
            ownerName={ownerName}
            onRemoved={onClose}
          />
        </div>
      ) : null}
    </DetailDrawer>
  );
}

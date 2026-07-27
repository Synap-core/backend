"use client";

/**
 * "Approve & always…" — the secondary affordance beside the primary Approve
 * button. Approving normally decides once; picking a granularity here does
 * that AND writes one revocable `governance_rules` row (Governance
 * Convergence Plan, Phase A/D) so the same kind of write auto-approves next
 * time — until someone revokes it in Governance rules.
 *
 * The five granularities are described in the header of
 * `packages/api/src/routers/governance-rules.ts`; only the ones this
 * proposal's own data supports are offered — never guessed.
 *
 * NOTE (Phase A limitation, see resolve-agent-governance-decision.ts's
 * `scoreRuleTarget`): a `targetKind: "capability"` rule is stored and
 * revocable today, but the resolver doesn't consult capability-target rows
 * yet — "always approve this capability" won't actually auto-approve future
 * runs until that wiring lands. Still offered (it's the documented door),
 * degrades to a no-op rather than lying about what's possible.
 */

import { useState } from "react";
import {
  Button,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
  addToast,
} from "@heroui/react";
import { ChevronDown, Repeat } from "lucide-react";
import { trpc } from "../../../lib/trpc";

type CreateRuleInput = Parameters<
  ReturnType<typeof trpc.governanceRules.create.useMutation>["mutate"]
>[0];

interface Granularity {
  key: string;
  label: string;
  build: (p: ProposalForRule) => CreateRuleInput;
}

/** The subset of the proposal's own rendered fields this menu reads. */
export interface ProposalForRule {
  id: string;
  targetType?: string | null;
  targetId?: string | null;
  proposalType?: string | null;
  agentUserId?: string | null;
  workspaceId?: string | null;
  request?: { data?: unknown } | null;
}

function stringField(data: unknown, key: string): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const v = (data as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** Derive the applicable granularities from data already on the page — a
 * granularity is offered only when the proposal actually carries the field
 * it needs (e.g. no `agentUserId` → no "this agent" option). */
function deriveGranularities(p: ProposalForRule): Granularity[] {
  const scope = p.workspaceId
    ? ({ scopeKind: "workspace", workspaceId: p.workspaceId } as const)
    : ({ scopeKind: "pod" } as const);
  const eventKey =
    p.targetType && p.proposalType
      ? `${p.targetType}.${p.proposalType}`
      : undefined;
  const options: Granularity[] = [];

  // "This capability" — a `capability.run` proposal stores `data.verbId`
  // (e.g. "unipile_list_accounts"), not `data.capabilityId`; the gate
  // (`gateCapabilityExecution`) matches a capability rule on that verb name.
  // Prefer verbId, fall back to skillId, then the older `capabilityId` shape
  // (some gate paths still store that) so the rule we create is byte-identical
  // to what the gate resolves. (Phase 2 / Option B wired the gate to consult
  // these; a verdict:"auto" rule authorizes the run — never a secret, never
  // past the approval floor.)
  const verbId =
    stringField(p.request?.data, "verbId") ??
    stringField(p.request?.data, "skillId") ??
    stringField(p.request?.data, "capabilityId");
  if (verbId) {
    options.push({
      key: "capability",
      label: `Always approve "${verbId}"`,
      build: () => ({
        principalKind: "any",
        ...scope,
        targetKind: "capability",
        targetPattern: verbId,
        verdict: "auto",
        sourceProposalId: p.id,
      }),
    });
  }

  if (eventKey) {
    options.push({
      key: "action",
      label: `All "${p.targetType} ${p.proposalType}" actions`,
      build: () => ({
        principalKind: "any",
        ...scope,
        targetKind: "action",
        targetPattern: eventKey,
        verdict: "auto",
        sourceProposalId: p.id,
      }),
    });
  }

  const profileSlug =
    stringField(p.request?.data, "profileSlug") ??
    stringField(p.request?.data, "type");
  if (profileSlug) {
    options.push({
      key: "profile",
      label: `Everything of type "${profileSlug}"`,
      build: () => ({
        principalKind: "any",
        ...scope,
        targetKind: "profile",
        targetPattern: "*",
        targetProfile: profileSlug,
        verdict: "auto",
        sourceProposalId: p.id,
      }),
    });
  }

  if (p.agentUserId && eventKey) {
    options.push({
      key: "agent",
      label: "This same action from this agent",
      build: () => ({
        principalKind: "agent",
        agentUserId: p.agentUserId!,
        ...scope,
        targetKind: "action",
        targetPattern: eventKey,
        verdict: "auto",
        sourceProposalId: p.id,
      }),
    });
  }

  options.push({
    key: "global",
    label: "Everything, always",
    build: () => ({
      principalKind: "any",
      scopeKind: "pod",
      targetKind: "action",
      targetPattern: "*",
      verdict: "auto",
      sourceProposalId: p.id,
    }),
  });

  return options;
}

export function AlwaysApproveMenu({
  proposal,
  disabled,
  onDone,
}: {
  proposal: ProposalForRule;
  disabled?: boolean;
  onDone: () => void;
}) {
  const [running, setRunning] = useState(false);
  const approve = trpc.proposals.approve.useMutation();
  const createRule = trpc.governanceRules.create.useMutation();

  const granularities = deriveGranularities(proposal);

  async function approveAndAlways(g: Granularity) {
    setRunning(true);
    try {
      await approve.mutateAsync({ proposalId: proposal.id });
      try {
        await createRule.mutateAsync(g.build(proposal));
        addToast({
          title: "Approved",
          description: `Rule created — "${g.label}" will auto-approve from now on. Revocable in Governance rules.`,
          color: "success",
        });
      } catch (ruleError) {
        addToast({
          title: "Approved",
          description: `The change went through, but the always-approve rule wasn't created: ${
            ruleError instanceof Error ? ruleError.message : "unknown error"
          }`,
          color: "warning",
        });
      }
      onDone();
    } catch (approveError) {
      addToast({
        title: "Could not approve",
        description:
          approveError instanceof Error
            ? approveError.message
            : "unknown error",
        color: "danger",
      });
    } finally {
      setRunning(false);
    }
  }

  return (
    <Dropdown placement="bottom-start">
      <DropdownTrigger>
        <Button
          variant="flat"
          className="min-h-10"
          startContent={<Repeat size={14} />}
          endContent={<ChevronDown size={14} />}
          isLoading={running}
          isDisabled={disabled || running}
        >
          Approve &amp; always…
        </Button>
      </DropdownTrigger>
      <DropdownMenu
        aria-label="Approve and create an always-approve rule"
        disabledKeys={running ? granularities.map((g) => g.key) : []}
        onAction={(key) => {
          const g = granularities.find((item) => item.key === key);
          if (g) void approveAndAlways(g);
        }}
      >
        {granularities.map((g) => (
          <DropdownItem
            key={g.key}
            description="Auto-approved next time — revocable"
          >
            {g.label}
          </DropdownItem>
        ))}
      </DropdownMenu>
    </Dropdown>
  );
}

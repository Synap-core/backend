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
import {
  deriveGovernanceGrantOptions,
  resolveCapabilityTarget,
  type GovernanceGrantOption,
} from "@synap-core/types";
import { trpc } from "../../../lib/trpc";

type CreateRuleInput = Parameters<
  ReturnType<typeof trpc.governanceRules.create.useMutation>["mutate"]
>[0];

interface Granularity {
  key: GovernanceGrantOption["id"];
  label: string;
  input: CreateRuleInput;
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

/** Operator-facing label copy for each granularity — the option DERIVATION is
 * shared (`deriveGovernanceGrantOptions(..., "operator-any")`); only the
 * wording is pod-admin's own (`GovernanceMenu` words the same ids for the
 * end-user surface). The "action" label reads the raw `targetType`/`proposalType`
 * (space-separated) rather than the `<type>.<action>` event key. */
const GRANT_LABELS: Record<
  GovernanceGrantOption["id"],
  (p: ProposalForRule, value?: string) => string
> = {
  capability: (_p, value) => `Always approve "${value}"`,
  action: (p) => `All "${p.targetType} ${p.proposalType}" actions`,
  profile: (_p, value) => `Everything of type "${value}"`,
  agent: () => "This same action from this agent",
  global: () => "Everything, always",
};

/** Derive the applicable granularities from data already on the page — a
 * granularity is offered only when the proposal actually carries the field
 * it needs (e.g. no `agentUserId` → no "this agent" option). The which-and-what
 * decision (and the exact `governanceRules.create` payloads) is the shared pure
 * `deriveGovernanceGrantOptions` in `@synap-core/types` — the SAME function
 * synap-app's `GovernanceMenu` calls, here with the operator (`"operator-any"`)
 * mode; this file only maps pod-admin's raw proposal-row fields into the shared
 * context and supplies operator label copy. */
function deriveGrantOptions(p: ProposalForRule): Granularity[] {
  const actionKey =
    p.targetType && p.proposalType
      ? `${p.targetType}.${p.proposalType}`
      : undefined;
  // profileSlug has no shared resolver — keep pod-admin's own `profileSlug ?? type`
  // resolution so the derived rule stays identical to the prior inline logic.
  const profileSlug =
    stringField(p.request?.data, "profileSlug") ??
    stringField(p.request?.data, "type");

  const options = deriveGovernanceGrantOptions(
    {
      proposalId: p.id,
      workspaceId: p.workspaceId,
      agentUserId: p.agentUserId,
      capabilityTarget: resolveCapabilityTarget(p.request?.data),
      actionKey,
      profileSlug,
    },
    "operator-any"
  );

  return options.map((o) => ({
    key: o.id,
    label: GRANT_LABELS[o.id](p, o.value),
    input: o.rule as CreateRuleInput,
  }));
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

  const granularities = deriveGrantOptions(proposal);

  async function approveAndAlways(g: Granularity) {
    setRunning(true);
    try {
      await approve.mutateAsync({ proposalId: proposal.id });
      try {
        await createRule.mutateAsync(g.input);
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

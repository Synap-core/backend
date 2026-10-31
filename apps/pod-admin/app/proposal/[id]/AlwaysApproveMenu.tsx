"use client";

/**
 * "Approve & always…" — the secondary affordance beside the primary Approve
 * button. Approving normally decides once; picking a granularity here does
 * that AND writes one revocable `governance_rules` row (Governance
 * Convergence Plan, Phase A/D) so the same kind of write auto-approves next
 * time — until someone takes it back in a space's Governance tab.
 *
 * The granularities are described in the header of
 * `packages/api/src/routers/governance-rules.ts`; only the ones this
 * proposal's own data supports are offered — never guessed. Each one says
 * what it covers and what still asks (`copy.ts`, `always.*`).
 *
 * "This tool" writes a `targetKind: "capability"` row, the ONLY rule that can
 * authorize a tool run: the capability gate consults the resolver, which
 * skips every broad rule for a run (the outward floor). There is no
 * "Everything, always" here: `deriveGovernanceGrantOptions` writes no wildcard
 * rule in pod admin (finding c173cc51).
 *
 * "Reject & never…" (`RejectNeverMenu`) is the third answer of decision G3:
 * it rejects AND writes one `deny` row for this agent and this act
 * (`deriveGovernanceNeverOption`, never a wildcard), so the pod refuses the
 * same write from then on with `DENIED_BY_RULE`, above the floors (decision
 * 956930ad). Pod admin runs the pod: a rule about what an agent may do.
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
import { Ban, ChevronDown, Repeat } from "lucide-react";
import {
  deriveGovernanceGrantOptions,
  deriveGovernanceNeverOption,
  resolveCapabilityTarget,
  type GovernanceGrantContext,
  type GovernanceGrantOption,
} from "@synap-core/types";
import {
  resolveActionLabel,
  resolveObjectNoun,
} from "@synap-core/types/vocabulary";
import { trpc } from "../../../lib/trpc";
import { alwaysApproveT } from "./copy";
import { approveInput, renderedRevision } from "./use-proposal-decision";

type CreateRuleInput = Parameters<
  ReturnType<typeof trpc.governanceRules.create.useMutation>["mutate"]
>[0];

interface Granularity {
  key: GovernanceGrantOption["id"];
  label: string;
  /** What the rule covers and what still asks. */
  covers: string;
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
  revisionHistory?: unknown;
}

function stringField(data: unknown, key: string): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const v = (data as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v : undefined;
}

type T = ReturnType<typeof alwaysApproveT>;

/** Operator-facing words for each granularity — the option DERIVATION is
 * shared (`deriveGovernanceGrantOptions(..., "operator-any")`); only the
 * wording is pod-admin's own (`GovernanceMenu` words the same ids for the
 * end-user surface). "global" is never derived in operator mode. */
function grantWords(
  t: T,
  id: GovernanceGrantOption["id"],
  p: ProposalForRule,
  value?: string
): { label: string; covers: string } | null {
  switch (id) {
    case "capability":
      return {
        label: t("always.capability.label", { name: value ?? "" }),
        covers: t("always.capability.covers"),
      };
    case "action":
      return {
        label: t("always.action.label", {
          change: `${resolveActionLabel(p.proposalType)} ${resolveObjectNoun(
            p.targetType
          ).toLowerCase()}`,
        }),
        covers: t("always.action.covers"),
      };
    case "profile":
      return {
        label: t("always.profile.label", { kind: resolveObjectNoun(value) }),
        covers: t("always.profile.covers"),
      };
    case "agent":
      return {
        label: t("always.agent.label"),
        covers: t("always.agent.covers"),
      };
    case "global":
      return null;
  }
}

/** Pod-admin's raw proposal-row fields, mapped into the shared context
 * both derivations ("always" and "never") read. */
function grantContext(p: ProposalForRule): GovernanceGrantContext {
  const actionKey =
    p.targetType && p.proposalType
      ? `${p.targetType}.${p.proposalType}`
      : undefined;
  // profileSlug has no shared resolver — keep pod-admin's own `profileSlug ?? type`
  // resolution so the derived rule stays identical to the prior inline logic.
  const profileSlug =
    stringField(p.request?.data, "profileSlug") ??
    stringField(p.request?.data, "type");
  return {
    proposalId: p.id,
    workspaceId: p.workspaceId,
    agentUserId: p.agentUserId,
    capabilityTarget: resolveCapabilityTarget(p.request?.data),
    actionKey,
    profileSlug,
  };
}

/** Derive the applicable granularities from data already on the page — a
 * granularity is offered only when the proposal actually carries the field
 * it needs (e.g. no `agentUserId` → no "this agent" option). The which-and-what
 * decision (and the exact `governanceRules.create` payloads) is the shared pure
 * `deriveGovernanceGrantOptions` in `@synap-core/types` — the SAME function
 * synap-app's `GovernanceMenu` calls, here with the operator (`"operator-any"`)
 * mode; this file only maps pod-admin's raw proposal-row fields into the shared
 * context and supplies operator label copy. */
function deriveGrantOptions(p: ProposalForRule, t: T): Granularity[] {
  const options = deriveGovernanceGrantOptions(grantContext(p), "operator-any");

  return options.flatMap((o) => {
    const words = grantWords(t, o.id, p, o.value);
    return words
      ? [{ key: o.id, ...words, input: o.rule as CreateRuleInput }]
      : [];
  });
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

  const t = alwaysApproveT();
  const granularities = deriveGrantOptions(proposal, t);

  async function approveAndAlways(g: Granularity) {
    setRunning(true);
    try {
      await approve.mutateAsync(
        approveInput(proposal.id, {}, renderedRevision(proposal))
      );
      try {
        await createRule.mutateAsync(g.input);
        addToast({
          title: t("always.done.title"),
          description: t("always.done.body", { label: g.label }),
          color: "success",
        });
      } catch (ruleError) {
        addToast({
          title: t("always.done.title"),
          description: t("always.ruleFailed", {
            reason:
              ruleError instanceof Error
                ? ruleError.message
                : t("always.noReason"),
          }),
          color: "warning",
        });
      }
      onDone();
    } catch (approveError) {
      addToast({
        title: t("always.approveFailed"),
        description:
          approveError instanceof Error
            ? approveError.message
            : t("always.noReason"),
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
          {t("always.trigger")}
        </Button>
      </DropdownTrigger>
      <DropdownMenu
        aria-label={t("always.menu")}
        disabledKeys={running ? granularities.map((g) => g.key) : []}
        onAction={(key) => {
          const g = granularities.find((item) => item.key === key);
          if (g) void approveAndAlways(g);
        }}
      >
        {granularities.map((g) => (
          <DropdownItem key={g.key} description={g.covers}>
            {g.label}
          </DropdownItem>
        ))}
      </DropdownMenu>
    </Dropdown>
  );
}

/**
 * "Reject & never…": the request's "Never" (decision G3). Rejects, then
 * writes the deny `deriveGovernanceNeverOption` derives. Absent when the
 * request names no agent or no single act (the derivation returns null).
 */
export function RejectNeverMenu({
  proposal,
  disabled,
  onDone,
}: {
  proposal: ProposalForRule;
  disabled?: boolean;
  onDone: () => void;
}) {
  const [running, setRunning] = useState(false);
  const reject = trpc.proposals.reject.useMutation();
  const createRule = trpc.governanceRules.create.useMutation();

  const t = alwaysApproveT();
  const never = deriveGovernanceNeverOption(grantContext(proposal));
  if (!never) return null;
  const words =
    never.rule.targetKind === "capability"
      ? {
          label: t("never.capability.label", { name: never.value }),
          covers: t("never.capability.covers"),
        }
      : {
          label: t("never.action.label"),
          covers: t("never.action.covers"),
        };

  async function rejectAndNever(rule: CreateRuleInput, label: string) {
    setRunning(true);
    try {
      await reject.mutateAsync({
        proposalId: proposal.id,
        reason: t("never.reason"),
      });
      try {
        await createRule.mutateAsync(rule);
        addToast({
          title: t("never.done.title"),
          description: t("never.done.body", { label }),
          color: "success",
        });
      } catch (ruleError) {
        addToast({
          title: t("never.done.title"),
          description: t("never.ruleFailed", {
            reason:
              ruleError instanceof Error
                ? ruleError.message
                : t("always.noReason"),
          }),
          color: "warning",
        });
      }
      onDone();
    } catch (rejectError) {
      addToast({
        title: t("never.rejectFailed"),
        description:
          rejectError instanceof Error
            ? rejectError.message
            : t("always.noReason"),
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
          color="danger"
          variant="light"
          className="min-h-10"
          startContent={<Ban size={14} />}
          endContent={<ChevronDown size={14} />}
          isLoading={running}
          isDisabled={disabled || running}
        >
          {t("never.trigger")}
        </Button>
      </DropdownTrigger>
      <DropdownMenu
        aria-label={t("never.menu")}
        disabledKeys={running ? ["never"] : []}
        onAction={() =>
          void rejectAndNever(never.rule as CreateRuleInput, words.label)
        }
      >
        <DropdownItem key="never" description={words.covers}>
          {words.label}
        </DropdownItem>
      </DropdownMenu>
    </Dropdown>
  );
}

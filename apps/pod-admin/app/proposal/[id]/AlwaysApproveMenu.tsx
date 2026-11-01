"use client";

/**
 * "Approve & always…" — the secondary affordance beside the primary Approve
 * button. Approving normally decides once; picking a granularity here does
 * that AND writes one revocable `governance_rules` row (Governance
 * Convergence Plan, Phase A/D) so the same kind of write auto-approves next
 * time — until someone takes it back in Settings (`request-rules.tsx`).
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
 * Both speak through the decision's receipt door (`decision-receipt.ts`):
 * "Approved" only when the pod's answer says it applied, a failure stays until
 * it is closed and never shows a raw exception. No Undo: taking the decision
 * back would leave its rule standing.
 *
 * "Reject and never allow…" (`RejectNeverMenu`) writes one pod-wide `deny` row
 * for this agent and this act (`deriveGovernanceNeverOption`, never a
 * wildcard), then rejects, so the pod refuses the same write from then on
 * with `DENIED_BY_RULE`, above the floors (decision 956930ad). Pod admin runs
 * the pod: a rule about what an agent may do. Both menus are offered to a pod
 * admin only (`ProposalReviewCard`): the rule door refuses anyone else.
 */

import { useState } from "react";
import {
  Button,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
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
  buildObjectActionTitle,
  resolveObjectNoun,
} from "@synap-core/types/vocabulary";
import { trpc } from "../../../lib/trpc";
import { showApprovalProgressToast } from "../../_lib/approval-progress/approval-progress-toast";
import {
  decisionFailure,
  decisionReceipt,
  readApproveAnswer,
  readRejectAnswer,
  typedDetail,
  type DecisionError,
  type DecisionOutcome,
  type Receipt,
} from "../../_lib/receipt/decision-receipt";
import { showReceipt } from "../../_lib/receipt/decision-receipt-toast";
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
  /** The engine's reason code: a floor no rule widens offers no rule. */
  governanceReason?: string | null;
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
 * end-user surface). "global" is never derived in operator mode. A session's
 * tool grant says what it really opens: the tools it hands out then run,
 * sends included, with no ask. */
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
          change: buildObjectActionTitle({
            action: p.proposalType,
            objectKind: p.targetType,
          }),
        }),
        covers: isToolGrant(p)
          ? t("always.grant.covers")
          : t("always.action.covers"),
      };
    case "profile":
      return {
        label: t("always.profile.label", { kind: resolveObjectNoun(value) }),
        covers: t("always.profile.covers"),
      };
    case "agent":
      return {
        label: t("always.agent.label"),
        covers: isToolGrant(p)
          ? t("always.grantAgent.covers")
          : t("always.agent.covers"),
      };
    case "global":
      return null;
  }
}

/** A session's tool grant (`focus_session.grant_capability`). */
function isToolGrant(p: ProposalForRule): boolean {
  return (
    p.targetType === "focus_session" && p.proposalType === "grant_capability"
  );
}

/** The rule's line after a decision: the decision's receipt, plus what the
 * rule now covers. Its Undo hint goes: this receipt offers no Undo. */
function withRule(outcome: DecisionOutcome, body: string): Receipt {
  const receipt = decisionReceipt(outcome);
  const said = receipt.undo ? undefined : receipt.description;
  return {
    ...receipt,
    description: [said, body].filter(Boolean).join(" "),
    undo: false,
  };
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
    governanceReason: p.governanceReason,
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
      // `null`: a large graph applies in the background, and its own toast
      // says when; this receipt then speaks only of the rule.
      let outcome: DecisionOutcome | null;
      try {
        const answer = await approve.mutateAsync(
          approveInput(proposal.id, {}, renderedRevision(proposal))
        );
        if ((answer as { queued?: boolean }).queued) {
          showApprovalProgressToast(proposal.id);
          outcome = null;
        } else outcome = readApproveAnswer(answer);
      } catch (err) {
        outcome = decisionFailure("approve", err as DecisionError);
      }
      if (outcome?.state === "failed") {
        showReceipt(decisionReceipt(outcome));
        return;
      }
      try {
        await createRule.mutateAsync(g.input);
        const body = t("always.done.body", { label: g.label });
        showReceipt(
          outcome
            ? withRule(outcome, body)
            : {
                title: t("always.ruleSaved"),
                description: body,
                tone: "success",
                undo: false,
              }
        );
      } catch (ruleError) {
        showReceipt({
          title: t("always.ruleFailed"),
          description:
            typedDetail(ruleError as DecisionError) ??
            t("always.ruleFailedHint"),
          tone: "danger",
          undo: false,
        });
      }
      onDone();
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
 * "Reject and never allow…": the request's "Never". Writes the pod-wide deny
 * `deriveGovernanceNeverOption` derives, then rejects. Absent when the
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

  // The rule first: the rejection tells the agent "refused for good", which
  // is true only once the rule is saved. A refused rule leaves the request as
  // it was; a refused rejection leaves the rule, which is safe (a deny beside
  // a pending request) and said.
  async function rejectAndNever(rule: CreateRuleInput, label: string) {
    setRunning(true);
    try {
      try {
        await createRule.mutateAsync(rule);
      } catch (ruleError) {
        showReceipt({
          title: t("never.ruleFailed"),
          description:
            typedDetail(ruleError as DecisionError) ??
            t("never.ruleFailedHint"),
          tone: "danger",
          undo: false,
        });
        return;
      }
      let outcome: DecisionOutcome;
      try {
        outcome = readRejectAnswer(
          await reject.mutateAsync({
            proposalId: proposal.id,
            reason: t("never.reason"),
          })
        );
      } catch (err) {
        outcome = decisionFailure("reject", err as DecisionError);
      }
      if (outcome.state === "failed") {
        showReceipt({
          ...decisionReceipt(outcome),
          title: t("never.rejectFailed"),
        });
        return;
      }
      showReceipt(withRule(outcome, t("never.done.body", { label })));
      onDone();
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

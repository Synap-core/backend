"use client";

/**
 * Governance rules panel — makes good on the "Revocable in Governance rules"
 * promise every "always approve" toast makes (`AlwaysApproveMenu.tsx`,
 * synap-app's `GovernanceMenu.tsx`). Until this existed, `governanceRules.list`
 * and `.revoke` had zero consumers and the only way to undo a standing rule
 * was raw SQL (GOVERNANCE-PHASE2-PLAN.md §2, D2).
 *
 * Lists active rules visible to this workspace (workspace-scoped + pod-wide),
 * newest first, with a Revoke button per row. Humanization lives in the
 * framework-agnostic `../../../../lib/governance-rules/rule-view-model.ts` —
 * see that file's header for why it isn't literally shared with the browser.
 */

import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  addToast,
  useDisclosure,
} from "@heroui/react";
import { Ban, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { trpc } from "../../../../../lib/trpc";
import { SectionCard } from "../../../components/section-card";
import {
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../../components/resource-row";
import {
  type GovernanceRuleRow,
  humanizePrincipal,
  humanizeScope,
  humanizeTarget,
  provenanceLabel,
  ruleProvenance,
  verdictLabel,
} from "../../../../../lib/governance-rules/rule-view-model";

function formatDate(d: string | Date): string {
  return new Date(d).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function GovernanceRulesPanel({
  workspaceId,
  workspaceName,
}: {
  workspaceId: string;
  workspaceName?: string;
}) {
  const [revokeTarget, setRevokeTarget] = useState<GovernanceRuleRow | null>(
    null
  );
  const utils = trpc.useUtils();

  const rulesQuery = trpc.governanceRules.list.useQuery({ workspaceId });
  const rules =
    (rulesQuery.data?.rules as GovernanceRuleRow[] | undefined) ?? [];

  const revokeMutation = trpc.governanceRules.revoke.useMutation({
    onSuccess: () => {
      void utils.governanceRules.list.invalidate({ workspaceId });
      addToast({ title: "Rule revoked", color: "default" });
      setRevokeTarget(null);
    },
    onError: (err) => {
      addToast({
        title: "Revoke failed",
        description: err.message,
        color: "danger",
      });
    },
  });

  return (
    <SectionCard
      title="Governance rules"
      hint="Standing always-approve / require-proposal rules, from Settings or from approving a proposal."
    >
      {rulesQuery.isLoading ? (
        <ResourceRowSkeleton count={3} />
      ) : rulesQuery.isError ? (
        <ResourceRowError
          message="Couldn't load governance rules."
          onRetry={() => void rulesQuery.refetch()}
        />
      ) : rules.length === 0 ? (
        <ResourceRowEmpty message="No standing rules yet." />
      ) : (
        <div className="flex flex-col divide-y divide-foreground/[0.05] pt-1">
          {rules.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              workspaceName={workspaceName}
              onRevoke={() => setRevokeTarget(rule)}
            />
          ))}
        </div>
      )}

      {revokeTarget ? (
        <RevokeRuleModal
          rule={revokeTarget}
          isPending={revokeMutation.isPending}
          onClose={() => setRevokeTarget(null)}
          onConfirm={() => revokeMutation.mutate({ id: revokeTarget.id })}
        />
      ) : null}
    </SectionCard>
  );
}

// ─── Row ────────────────────────────────────────────────────────────────

function RuleRow({
  rule,
  workspaceName,
  onRevoke,
}: {
  rule: GovernanceRuleRow;
  workspaceName?: string;
  onRevoke: () => void;
}) {
  const isProposalAuthored = ruleProvenance(rule) === "proposal";

  return (
    <div className="flex items-center gap-3 py-3 px-1">
      <ShieldCheck
        className="h-4 w-4 shrink-0 text-foreground/40"
        strokeWidth={2}
        aria-hidden
      />

      <div className="min-w-0 flex-1 flex flex-col gap-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-medium text-foreground">
            {humanizeTarget(rule)}
          </span>
          <span
            className={[
              "rounded-full px-2 py-0.5 text-[10.5px] font-medium",
              rule.verdict === "auto"
                ? "bg-status-healthy/10 text-status-healthy ring-1 ring-inset ring-status-healthy/30"
                : "bg-foreground/[0.06] text-foreground/55",
            ].join(" ")}
          >
            {verdictLabel(rule)}
          </span>
          <span
            className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10.5px] text-foreground/55"
            title={
              isProposalAuthored
                ? "Created by approving a proposal"
                : "Created directly in Settings"
            }
          >
            {provenanceLabel(rule)}
          </span>
        </div>
        <span className="text-[11px] text-foreground/40">
          {humanizePrincipal(rule)} · {humanizeScope(rule, workspaceName)} ·
          created {formatDate(rule.createdAt)}
          {rule.expiresAt ? ` · expires ${formatDate(rule.expiresAt)}` : ""}
        </span>
      </div>

      <Button
        isIconOnly
        size="sm"
        variant="light"
        radius="full"
        aria-label="Revoke rule"
        className="shrink-0 min-h-10 min-w-10 text-foreground/40 hover:text-status-down"
        onPress={onRevoke}
      >
        <Ban className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

// ─── Revoke confirm modal ────────────────────────────────────────────────

function RevokeRuleModal({
  rule,
  isPending,
  onClose,
  onConfirm,
}: {
  rule: GovernanceRuleRow;
  isPending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { isOpen, onOpenChange } = useDisclosure({
    defaultOpen: true,
    onClose,
  });

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      size="md"
      placement="center"
    >
      <ModalContent>
        <ModalHeader className="flex items-center gap-2 border-b border-foreground/[0.06] px-6 py-4">
          <span
            className="glass-icon flex h-7 w-7 items-center justify-center"
            style={{ background: "rgba(248, 113, 113, 0.18)" }}
          >
            <Ban className="h-3.5 w-3.5 text-foreground/85" />
          </span>
          <span className="text-[15px] font-medium">Revoke rule</span>
        </ModalHeader>
        <ModalBody className="gap-3 px-6 py-4">
          <p className="text-[12.5px] text-foreground/85">
            {humanizeTarget(rule)} will stop being auto-decided for{" "}
            {humanizePrincipal(rule).toLowerCase()}. Future matches go back
            through normal proposal review.
          </p>
        </ModalBody>
        <ModalFooter className="border-t border-foreground/[0.06] px-6 py-3">
          <Button
            variant="flat"
            radius="md"
            size="sm"
            onPress={onClose}
            isDisabled={isPending}
          >
            Cancel
          </Button>
          <Button
            color="danger"
            radius="md"
            size="sm"
            isLoading={isPending}
            onPress={onConfirm}
          >
            Revoke
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

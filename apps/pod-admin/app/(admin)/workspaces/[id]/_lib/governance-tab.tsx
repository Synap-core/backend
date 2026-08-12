"use client";

/**
 * Governance tab — workspace AI governance settings.
 *
 * Form: driven by useConfigForm + ConfigForm (headless + HeroUI renderer).
 * Saves the non-auto-approve dials via
 * trpc.workspaces.update → { settings: { aiGovernance: … } }.
 *
 * The workspace auto-approve grant (`autoApproveFor`) is NOT edited here — it
 * lives in `governance_rules` and is managed by <GovernanceRulesPanel/> below.
 * It was deliberately removed from this JSONB form: round-tripping the frozen
 * `settings.aiGovernance.autoApproveFor` back through `workspaces.update`
 * re-asserted (REPLACE semantics) stale grants over rules edited via the panel.
 */

import { addToast } from "@heroui/react";
import { useMemo } from "react";
import { trpc } from "../../../../../lib/trpc";
import { SectionCard } from "../../../components/section-card";
import type { ConfigFieldSpec } from "../../../../../lib/config-form/types";
import { useConfigForm } from "../../../../../lib/config-form/useConfigForm";
import { ConfigForm } from "../../../components/config-form/ConfigForm";
import { GovernanceRulesPanel } from "./governance-rules-panel";

// ─── Field specs ──────────────────────────────────────────────────────────────

const GOVERNANCE_FIELDS: ConfigFieldSpec[] = [
  {
    key: "proposalApprovalPolicy",
    label: "Proposal approval policy",
    description: "Who can approve AI proposals in this workspace.",
    valueType: "enum",
    enumValues: ["owner_and_admins", "any_editor", "admins_only"],
  },
  {
    key: "allowAgentCreation",
    label: "Allow agent creation",
    description: "Whether workspace members may create custom agents.",
    valueType: "boolean",
  },
  {
    key: "allowSelfServiceTwin",
    label: "Allow self-service twin",
    description:
      "Any workspace member can create their own twin agent without admin approval.",
    valueType: "boolean",
  },
  {
    key: "writesRequireProposal",
    label: "Writes require proposal",
    description:
      "When enabled, all agent write operations route through a proposal for human review.",
    valueType: "boolean",
  },
  {
    key: "maxAgentsPerUser",
    label: "Max agents per user",
    description:
      "Maximum number of AI agents each user may create (0 = unlimited).",
    valueType: "number",
    advanced: true,
  },
  {
    key: "navigationPermissions.autoApprove",
    label: "Auto-approve AI navigation",
    description:
      "AI-suggested panel/surface opens execute immediately without user confirmation.",
    valueType: "boolean",
    advanced: true,
  },
];

// ─── Component ────────────────────────────────────────────────────────────────

interface GovernanceTabProps {
  ws: {
    id: string;
    name?: string;
    settings: Record<string, unknown>;
  };
}

export function GovernanceTab({ ws }: GovernanceTabProps) {
  const utils = trpc.useUtils();

  const updateMutation = trpc.workspaces.update.useMutation({
    onSuccess: () => {
      void utils.workspaces.adminGet.invalidate({ id: ws.id });
    },
    onError: (err) => {
      addToast({
        title: "Save failed",
        description: err.message,
        color: "danger",
      });
    },
  });

  // Derive nested initial values. navigationPermissions.autoApprove maps to
  // a dotted key so useConfigForm can address it via getIn/setIn.
  const initial = useMemo<Record<string, unknown>>(() => {
    const gov = (ws.settings?.aiGovernance ?? {}) as Record<string, unknown>;
    const navPerms = (gov.navigationPermissions ?? {}) as Record<
      string,
      unknown
    >;
    return {
      proposalApprovalPolicy: gov.proposalApprovalPolicy ?? "owner_and_admins",
      allowAgentCreation: gov.allowAgentCreation ?? false,
      allowSelfServiceTwin: gov.allowSelfServiceTwin ?? false,
      writesRequireProposal: gov.writesRequireProposal ?? false,
      maxAgentsPerUser: gov.maxAgentsPerUser ?? 0,
      navigationPermissions: {
        autoApprove: navPerms.autoApprove ?? false,
      },
    };
  }, [ws.settings]);

  const form = useConfigForm({
    fields: GOVERNANCE_FIELDS,
    initial,
    onSave: async (values) => {
      // Reconstruct nested aiGovernance; navigationPermissions lives inside it.
      const navPerms = (
        values.navigationPermissions &&
        typeof values.navigationPermissions === "object"
          ? values.navigationPermissions
          : {}
      ) as Record<string, unknown>;

      const aiGovernance: Record<string, unknown> = {
        proposalApprovalPolicy: values.proposalApprovalPolicy,
        allowAgentCreation: values.allowAgentCreation,
        allowSelfServiceTwin: values.allowSelfServiceTwin,
        writesRequireProposal: values.writesRequireProposal,
        maxAgentsPerUser:
          values.maxAgentsPerUser !== undefined &&
          values.maxAgentsPerUser !== null
            ? Number(values.maxAgentsPerUser)
            : 0,
        navigationPermissions: {
          autoApprove: navPerms.autoApprove ?? false,
        },
      };

      await updateMutation.mutateAsync({
        id: ws.id,
        settings: { aiGovernance },
      });
    },
  });

  return (
    <div className="flex flex-col gap-5">
      {/* Governance form */}
      <SectionCard
        title="AI governance"
        hint="Controls how AI agents operate in this workspace."
      >
        <div className="pt-1">
          <ConfigForm fields={GOVERNANCE_FIELDS} form={form} />
        </div>
      </SectionCard>

      {/* Standing rules — the revocable "always approve for X" ledger */}
      <GovernanceRulesPanel workspaceId={ws.id} workspaceName={ws.name} />
    </div>
  );
}

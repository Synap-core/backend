"use client";

/**
 * Governance tab — workspace AI governance settings.
 *
 * Preset picker: 3 named modes from @synap/governance-policy that pre-fill
 * the form WITHOUT saving (user reviews then hits Save).
 *
 * Form: driven by useConfigForm + ConfigForm (headless + HeroUI renderer).
 * Saves via trpc.workspaces.update → { settings: { aiGovernance: … } }.
 */

import { addToast, Button } from "@heroui/react";
import { useMemo } from "react";
import {
  GOVERNANCE_MODES,
  type GovernanceMode,
} from "@synap/governance-policy";
import { trpc } from "../../../../../lib/trpc";
import { SectionCard } from "../../../components/section-card";
import type { ConfigFieldSpec } from "../../../../../lib/config-form/types";
import { useConfigForm } from "../../../../../lib/config-form/useConfigForm";
import { ConfigForm } from "../../../components/config-form/ConfigForm";

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
    key: "autoApproveFor",
    label: "Auto-approve actions",
    description:
      'AI action patterns that bypass proposal review. Format: "entity.create", "search.*", etc.',
    valueType: "string-list",
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

// ─── Preset label helpers ─────────────────────────────────────────────────────

const PRESET_DISPLAY: Record<GovernanceMode, { title: string; hint: string }> =
  {
    safe: {
      title: "Safe",
      hint: "Every change requires approval",
    },
    normal: {
      title: "Normal",
      hint: "Creates & edits instant, deletes need approval",
    },
    crazy: {
      title: "Crazy",
      hint: "Everything is instant",
    },
  };

// ─── Component ────────────────────────────────────────────────────────────────

interface GovernanceTabProps {
  ws: {
    id: string;
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
      autoApproveFor: gov.autoApproveFor ?? [],
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
        autoApproveFor: values.autoApproveFor,
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

  // Active-preset detection: compare autoApproveFor (set-equality) +
  // writesRequireProposal against each preset. Only autoApproveFor and
  // writesRequireProposal are preset-controlled — the section is scoped
  // honestly to "approval stance" rather than all governance fields.
  const activeMode = useMemo<GovernanceMode | null>(() => {
    const currentAutoApprove = Array.isArray(form.values.autoApproveFor)
      ? (form.values.autoApproveFor as string[])
      : [];
    const currentWritesRequireProposal =
      form.values.writesRequireProposal === true ||
      form.values.writesRequireProposal === "true";

    for (const mode of Object.keys(GOVERNANCE_MODES) as GovernanceMode[]) {
      const preset = GOVERNANCE_MODES[mode];
      const presetList = [...preset.autoApproveFor];
      const presetSet = new Set<string>(presetList);
      const currentSet = new Set<string>(currentAutoApprove);
      const setsMatch =
        presetSet.size === currentSet.size &&
        presetList.every((x) => currentSet.has(x));
      if (
        setsMatch &&
        preset.writesRequireProposal === currentWritesRequireProposal
      ) {
        return mode;
      }
    }
    return null;
  }, [form.values]);

  // Preset picker: populates form values WITHOUT saving.
  function applyPreset(mode: GovernanceMode) {
    const preset = GOVERNANCE_MODES[mode];
    form.setField("autoApproveFor", [...preset.autoApproveFor]);
    form.setField("writesRequireProposal", preset.writesRequireProposal);
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Approval stance preset picker */}
      <SectionCard
        title="Approval stance"
        hint="Sets auto-approve actions and write-proposal policy. Review the form below, then Save."
      >
        <div className="flex flex-col gap-3 pt-1">
          <div className="flex flex-wrap gap-2">
            {(Object.keys(GOVERNANCE_MODES) as GovernanceMode[]).map((mode) => {
              const d = PRESET_DISPLAY[mode];
              const isActive = activeMode === mode;
              return (
                <Button
                  key={mode}
                  variant={isActive ? "solid" : "flat"}
                  color={isActive ? "primary" : "default"}
                  radius="md"
                  className="h-auto py-2 px-3"
                  onPress={() => applyPreset(mode)}
                >
                  <span className="flex flex-col items-start gap-0.5">
                    <span className="text-[12px] font-semibold leading-none">
                      {d.title}
                    </span>
                    <span className="text-[10.5px] font-normal opacity-65 leading-tight">
                      {d.hint}
                    </span>
                  </span>
                </Button>
              );
            })}
          </div>
          <p className="text-[11px] text-foreground/40">
            Clicking a preset pre-fills the form below. Review, then Save to
            apply.
          </p>
        </div>
      </SectionCard>

      {/* Governance form */}
      <SectionCard
        title="AI governance"
        hint="Controls how AI agents operate in this workspace."
      >
        <div className="pt-1">
          <ConfigForm fields={GOVERNANCE_FIELDS} form={form} />
        </div>
      </SectionCard>
    </div>
  );
}

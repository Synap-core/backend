"use client";

/**
 * "What agents on this computer may do" — the computer page's section (plan
 * 07ecf0be item 1, D2a/D3). A person's computer is the ceiling of every agent
 * on it: the governance resolver judges an agent as itself AND as its
 * computer and keeps the stricter answer. This is where that ceiling is seen
 * and changed.
 *
 * The choice is THE one pod admin offers wherever an agent's writes are set
 * (`WriteModeChoice`, rows from `AGENT_WRITE_MODE_CHOICES`), read and saved
 * like an agent's with the COMPUTER's id: `agentUsers.governance` and
 * `agentUsers.setPosture` (a computer is an agent user of type `machine`; the
 * door lets its creator or a pod admin set it, and both computer routes are
 * read by exactly those people). Every rule that applies sits behind
 * "Show the rules" (progressive disclosure), each tagged with its source.
 */

import { Button, addToast } from "@heroui/react";
import { useState } from "react";
import { agentPostureOfWriteMode } from "@synap-core/types/agents";
import { MATRIX_MARKS, matrixVerdictOf } from "@synap-core/types/agent-matrix";
import { resolveServiceName } from "@synap-core/types/service-marks";
import { resolveMatrixMarkLabel } from "@synap-core/types/vocabulary";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { useT } from "../../../../lib/i18n/locale-provider";
import {
  currentWriteMode,
  writeModeLabel,
  writeModeLines,
} from "../../../../lib/agent-writes/agent-writes";
import { WriteModeChoice } from "../../../_lib/write-mode-choice";
import { SectionCard } from "../../components/section-card";
import { toneTextClass } from "../../governance/agents/_lib/mark-tone";
import { en, fr } from "./copy";
import {
  computerRuleGroups,
  type ComputerRule,
  type ComputerRuleGroup,
  type RuleSource,
} from "./computer-writes";
import type { ComputerLike } from "./computer-model";

const CATALOGS = { en, fr };

/** Rules a group shows before "Show all N". */
const RULES_PREVIEW = 5;

export function ComputerWrites({ computer }: { computer: ComputerLike }) {
  const t = useT(CATALOGS);
  const utils = trpc.useUtils();
  const [showRules, setShowRules] = useState(false);
  const gov = trpc.agentUsers.governance.useQuery(
    { agentUserId: computer.id },
    { staleTime: 60_000, retry: false }
  );
  const setPosture = trpc.agentUsers.setPosture.useMutation({
    onSuccess: async (res) => {
      // The computer's ceiling changes what each of its agents may do.
      await Promise.all([
        utils.agentUsers.governance.invalidate(),
        utils.governanceRules.listAll.invalidate(),
      ]);
      addToast({
        title: t("writes.saved", {
          computer: computer.name,
          mode: writeModeLabel(res.posture),
        }),
        color: "success",
      });
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        title: t("writes.failed"),
        description: t("writes.failedHint"),
        color: "danger",
      });
    },
  });

  return (
    <SectionCard title={t("writes.title")}>
      {gov.isLoading ? (
        <div className="h-10 rounded-lg bg-foreground/[0.04] shimmer-pulse" />
      ) : gov.error?.data?.code === "NOT_FOUND" ? (
        // The door answers NOT_FOUND to anyone the computer does not answer to.
        <p className="text-[12.5px] text-foreground/65">{t("writes.whoMay")}</p>
      ) : gov.isError || !gov.data ? (
        <div className="flex items-center gap-3">
          <p className="text-[12.5px] text-status-down">
            {t("writes.loadFailed")}
          </p>
          <Button
            size="sm"
            variant="flat"
            radius="md"
            onPress={() => void gov.refetch()}
          >
            {t("writes.retry")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <WriteModeChoice
            label={t("writes.title")}
            // The pick shows while the pod saves it; a refused one falls back.
            value={
              setPosture.isPending && setPosture.variables
                ? (setPosture.variables.posture ?? "pod-default")
                : currentWriteMode(gov.data)
            }
            isDisabled={setPosture.isPending}
            lines={writeModeLines(gov.data)}
            onChange={(mode) =>
              setPosture.mutate({
                agentUserId: computer.id,
                posture: agentPostureOfWriteMode(mode),
              })
            }
          />
          <p className="text-[12.5px] text-foreground/75">
            {t("writes.ceiling", { computer: computer.name })}
          </p>
          <Button
            variant="light"
            size="sm"
            className="min-h-10 self-start"
            aria-expanded={showRules}
            onPress={() => setShowRules((v) => !v)}
          >
            {showRules ? t("rules.hide") : t("rules.show")}
          </Button>
          {showRules && <ComputerRules computer={computer} />}
        </div>
      )}
    </SectionCard>
  );
}

/** Every rule that applies to the computer or an agent on it, by source. */
function ComputerRules({ computer }: { computer: ComputerLike }) {
  const t = useT(CATALOGS);
  const rules = trpc.governanceRules.listAll.useQuery(undefined, {
    staleTime: 30_000,
    retry: false,
  });
  const spaces = trpc.workspaces.list.useQuery(undefined, {
    staleTime: 300_000,
    retry: false,
  });
  if (rules.isLoading)
    return (
      <div className="h-16 rounded-lg bg-foreground/[0.04] shimmer-pulse" />
    );
  if (rules.isError || !rules.data)
    return (
      <div className="flex items-center gap-3">
        <p className="text-[12.5px] text-status-down">
          {t("rules.loadFailed")}
        </p>
        <Button
          size="sm"
          variant="flat"
          radius="md"
          onPress={() => void rules.refetch()}
        >
          {t("writes.retry")}
        </Button>
      </div>
    );
  const groups = computerRuleGroups(rules.data.rules, {
    computerId: computer.id,
    agents: computer.agents.map((a) => ({
      id: a.id,
      name: a.name,
      agentType: a.agentType,
    })),
  });
  if (groups.length === 0)
    return (
      <p className="text-[12.5px] text-foreground/65">{t("rules.none")}</p>
    );
  const spaceName = new Map(
    (spaces.data ?? []).map((w) => [w.id, w.name] as const)
  );
  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <RuleGroup key={g.key} group={g} spaceName={spaceName} />
      ))}
    </div>
  );
}

function RuleGroup({
  group,
  spaceName,
}: {
  group: ComputerRuleGroup;
  spaceName: ReadonlyMap<string, string>;
}) {
  const t = useT(CATALOGS);
  const [all, setAll] = useState(false);
  const shown = all ? group.rules : group.rules.slice(0, RULES_PREVIEW);
  const sourceLabel = (s: RuleSource) =>
    s.kind === "computer"
      ? t("rules.source.computer")
      : s.kind === "allComputers"
        ? t("rules.source.allComputers")
        : s.kind === "agent"
          ? t("rules.source.agent", { name: s.name })
          : s.kind === "agentClass"
            ? t("rules.source.agentClass", {
                service: resolveServiceName(s.agentType),
              })
            : t("rules.source.pod");
  const what = (r: ComputerRule) => {
    const base = r.targetClass ? t(`rules.target.${r.targetClass}`) : r.what;
    if (!r.workspaceId) return base;
    const space = spaceName.get(r.workspaceId);
    return space
      ? t("rules.inSpace", { what: base, space })
      : t("rules.inAnySpace", { what: base });
  };
  return (
    <div className="flex flex-col gap-1">
      <p className="flex items-baseline gap-2 text-[12px] font-medium text-foreground">
        {sourceLabel(group.source)}
        <span className="font-normal text-foreground/65">
          {t("rules.count", { n: group.rules.length })}
        </span>
      </p>
      <ul className="flex flex-col divide-y divide-foreground/[0.05]">
        {shown.map((r) => {
          const verdict = matrixVerdictOf(r.verdict);
          const mark = MATRIX_MARKS[verdict];
          return (
            <li key={r.id} className="flex items-center gap-2 py-1.5">
              <span
                aria-hidden
                className={["w-4 text-[13px]", toneTextClass(mark.tone)].join(
                  " "
                )}
              >
                {mark.glyph}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground/85">
                {what(r)}
              </span>
              <span className="shrink-0 text-[12px] text-foreground/65">
                {resolveMatrixMarkLabel(verdict)}
              </span>
            </li>
          );
        })}
      </ul>
      {group.rules.length > RULES_PREVIEW && !all && (
        <Button
          variant="light"
          size="sm"
          className="self-start"
          onPress={() => setAll(true)}
        >
          {t("rules.showAll", { n: group.rules.length })}
        </Button>
      )}
    </div>
  );
}

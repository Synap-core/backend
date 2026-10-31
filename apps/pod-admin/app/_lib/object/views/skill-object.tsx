"use client";

/**
 * One skill, its own page — drawn by `/open/skill/:id`, the page a Tools row
 * (Instructions, Code) opens. It answers what Tools promises of every tool:
 * is it on, and what did it do.
 *
 * Read: `skills.get` in every space the reader can see (`allSpaces`: the page
 * is reached by id alone), user-floored, NOT_FOUND for one they cannot see.
 *
 *   • On or off is THE mark (`approvedStatus`, the Tools row's). An instruction
 *     that is off is turned on here, after its instructions are read whole in
 *     the confirmation (`skills.setApproved`; the pod re-checks the space
 *     owner or pod admin gate and its refusal stays in the dialog). Any other
 *     skill has a reach the pod reads server-side, which this page does not
 *     carry: it is turned on in the app.
 *   • An INSTRUCTION does not run: an agent reads it when it applies, and the
 *     pod records no such read (`GET /agent-skills/executable` and MCP
 *     `synap_load_skill` only read). So the page says it has no history and
 *     why, never an empty history that would read as "never used".
 *   • A code, declarative or builtin skill runs: its runs (`ToolRuns`).
 */

import { Button } from "@heroui/react";
import { useState } from "react";
import {
  humanizeToken,
  resolveActionLabel,
} from "@synap-core/types/vocabulary";
import { trpc } from "../../../../lib/trpc";
import { formatRelative, readableError } from "../../../../lib/format";
import { ExitLink } from "../../../../lib/exit-link";
import { openIn } from "../../../../lib/open-in";
import { useT } from "../../../../lib/i18n/locale-provider";
import { ConfirmModal } from "../../../(admin)/components/confirm-modal";
import { ProposedRecordCard } from "../../../proposal/[id]/ProposedRecordCard";
import { TOOLS_CATALOGS } from "../../../(admin)/tools/_lib/copy";
import { skillRow } from "../../../(admin)/tools/_lib/skills-model";
import { approvedStatus } from "../../../(admin)/tools/_lib/tool-status";
import { toolWhere } from "../../../(admin)/tools/_lib/tools-model";
import { actionLabelFor } from "../../../(admin)/tools/_lib/tool-runs-model";
import { ContentBody } from "../content/content-block";
import { prepareContent } from "../content/markdown-model";
import { couldNotLoad, loadFailure } from "../load-failure";
import { useReauthOnUnauthorized } from "../use-reauth";
import type { ObjectFrame } from "./object-frame";
import { ToolRuns } from "./tool-runs";

const NO_VERBS = actionLabelFor([]);

export function SkillObject({ id, frame }: { id: string; frame: ObjectFrame }) {
  const t = useT(TOOLS_CATALOGS);
  const utils = trpc.useUtils();
  const query = trpc.skills.get.useQuery(
    { id, allSpaces: true },
    { retry: false }
  );
  const workspaceId = query.data?.skill.workspaceId ?? null;
  const spaces = trpc.workspaces.list.useQuery(undefined, {
    enabled: Boolean(workspaceId),
    retry: false,
  });
  const [confirming, setConfirming] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const setApproved = trpc.skills.setApproved.useMutation({
    onSuccess: async () => {
      // The page stays: its mark turns to On, which is the whole receipt.
      setConfirming(false);
      setRefusal(null);
      await Promise.all([
        utils.skills.get.invalidate({ id }),
        utils.skills.list.invalidate(),
      ]);
    },
    onError: (err) => {
      // The pod's own words: who may turn it on is its call, not this page's.
      setRefusal(readableError(err.message) ?? t("skill.notTurnedOn"));
    },
  });
  useReauthOnUnauthorized(query.error, setApproved.error);

  if (query.isLoading) return frame.loading(t("loading"));
  const skill = query.data?.skill;
  const fail = loadFailure(query.error, "Tool");
  if (fail || !skill) {
    return frame.failure({
      kind: "skill",
      id,
      failure: fail ?? couldNotLoad("Tool"),
    });
  }

  const instruction = skill.kind === "instruction";
  const row = skillRow(skill);
  const spaceName = (wsId: string) =>
    (spaces.data ?? []).find((s) => s.id === wsId)?.name;
  const turnOn = resolveActionLabel("turn_on");
  const appExit = openIn({ kind: "objectInApp", objectKind: "skill", id });

  const primaryAction = skill.approved ? undefined : row.turnOn === "here" ? (
    <Button
      size="sm"
      color="primary"
      radius="md"
      onPress={() => {
        setRefusal(null);
        setConfirming(true);
      }}
    >
      {t("skill.readAndTurnOn")}
    </Button>
  ) : (
    <ExitLink exit={appExit} label={t("skill.turnOnInApp")} />
  );

  const body = skill.body?.trim();
  const instructionsSection = instruction && (
    <section className="flex flex-col gap-2">
      <h2 className="text-[13px] font-medium text-foreground">
        {t("skill.instructions")}
      </h2>
      {body ? (
        <ContentBody prepared={prepareContent(body, "markdown")} />
      ) : skill.bodyDocumentId ? (
        <p className="text-[12.5px] text-foreground/65">
          {t("skill.inDocument")}{" "}
          <ExitLink
            exit={openIn({
              kind: "object",
              objectKind: "document",
              id: skill.bodyDocumentId,
            })}
            label={t("skill.readDocument")}
          />
        </p>
      ) : (
        <p className="text-[12.5px] text-foreground/65">{t("skill.noBody")}</p>
      )}
    </section>
  );

  return (
    <>
      {frame.object({
        header: {
          kind: "skill",
          title: skill.name,
          summary: skill.description?.trim() || undefined,
          status: approvedStatus(skill),
          breadcrumb: frame.breadcrumb?.(skill.name),
          primaryAction,
          secondaryActions: skill.approved ? (
            <ExitLink exit={appExit} label={t("openInApp")} />
          ) : undefined,
        },
        facts: [
          { label: t("fact.space"), value: toolWhere(row, spaceName) },
          { label: t("fact.kind"), value: humanizeToken(skill.kind) },
          ...(row.slug ? [{ label: t("fact.loadsBy"), value: row.slug }] : []),
          {
            label: t("fact.added"),
            value: formatRelative(row.createdAt, { empty: "—" }),
          },
        ],
        children: instruction ? (
          <>
            {instructionsSection}
            <p className="text-[12.5px] text-foreground/65">
              {t("skill.silence")}
            </p>
          </>
        ) : (
          <ToolRuns tool={{ skillId: id }} actionLabel={NO_VERBS} />
        ),
        advanced: {
          ids: [
            { label: t("id.tool"), value: skill.id },
            ...(workspaceId
              ? [{ label: t("id.space"), value: workspaceId }]
              : []),
          ],
          raw: skill,
        },
      })}
      <ConfirmModal
        isOpen={confirming}
        onClose={() => {
          setConfirming(false);
          setRefusal(null);
        }}
        onConfirm={() => setApproved.mutate({ id, approved: true })}
        title={t("skill.turnOnTitle", { name: skill.name })}
        consequence={t("skill.turnOnConsequence")}
        confirmLabel={turnOn}
        confirmColor="warning"
        isPending={setApproved.isPending}
      >
        <div className="max-h-[50vh] overflow-y-auto">
          {row.record && <ProposedRecordCard record={row.record} />}
        </div>
        {refusal && <p className="text-[12.5px] text-status-down">{refusal}</p>}
      </ConfirmModal>
    </>
  );
}

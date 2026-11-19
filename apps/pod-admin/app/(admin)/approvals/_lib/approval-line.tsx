"use client";

/**
 * One approval on Approvals: what it covers as the title, its verdict as the
 * mark (runs on its own / asks first / never), who · where, where it came
 * from as a door, and its way back: Take back (a revoke the page confirms),
 * or the place it is set (a pod default's switch, an agent's posture), or the
 * approval a computer's copy goes with. Every row has one
 * (`approval-line.test.tsx`).
 */

import { Button } from "@heroui/react";
import {
  Ban,
  CheckCircle2,
  Clock,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import {
  humanizePrincipal,
  type ActionRunMode,
} from "@synap-core/types/governance-rules";
import { resolveActionRunModeLabel } from "@synap-core/types/vocabulary";
import { agentHref, navHref } from "../../../../lib/console-nav";
import { useT } from "../../../../lib/i18n/locale-provider";
import {
  approvalMode,
  approvalOrigin,
  approvalTakeBack,
  type ApprovalHrefs,
  type ApprovalRowLike,
} from "../../../../lib/governance-rules/approvals-model";
import { ResourceRow } from "../../components/resource-row";
import type { StatusKind } from "../../components/status-pill";
import { en, fr } from "./copy";

const CATALOGS = { en, fr };
const BASE = navHref("approvals");

export const APPROVAL_HREFS: ApprovalHrefs = {
  settings: navHref("settings"),
  agent: agentHref,
  proposal: (id) => `/proposal/${encodeURIComponent(id)}`,
  playbook: (id) => `${navHref("processes")}/${encodeURIComponent(id)}`,
};

/** A run mode's mark: runs on its own, asks first, never. */
export const MODE_TONE: Record<ActionRunMode, StatusKind> = {
  auto: "healthy",
  ask: "stale",
  never: "down",
};
export const MODE_ICON: Record<ActionRunMode, LucideIcon> = {
  auto: CheckCircle2,
  ask: Clock,
  never: Ban,
};

/** One approval: its verdict as the mark, who · where, where it came from, and its way back. */
export function ApprovalLine({
  row,
  title,
  where,
  onTakeBack,
}: {
  row: ApprovalRowLike;
  title: string;
  where: string;
  onTakeBack: () => void;
}) {
  const t = useT(CATALOGS);
  const mode = approvalMode(row.verdict);
  const origin = approvalOrigin(row, APPROVAL_HREFS);
  const back = approvalTakeBack(row, APPROVAL_HREFS);
  const who = humanizePrincipal(row);
  const originWords = t(`origin.${origin.key}`);
  return (
    <div data-row-id={row.id} className="rounded-md transition-shadow">
      <ResourceRow
        Icon={ShieldCheck}
        primary={title}
        // who · where · from: one line, the origin a door when it has a page,
        // so the right side holds only the mark and the way back.
        secondary={
          <>
            {who} · {where} · {t("row.fromLabel")}{" "}
            {origin.href ? (
              <Link
                href={origin.href}
                className="text-foreground/85 underline-offset-2 hover:underline"
              >
                {originWords}
              </Link>
            ) : (
              originWords
            )}
          </>
        }
        status={{
          kind: MODE_TONE[mode],
          label: resolveActionRunModeLabel(mode),
        }}
        wrap
        actions={
          <div className="flex flex-wrap items-center gap-1">
            {back.kind === "revoke" ? (
              <Button
                size="sm"
                variant="flat"
                radius="md"
                className="min-h-9"
                aria-label={t("takeBack.aria", { what: title, who })}
                onPress={onTakeBack}
              >
                {t("takeBack.label")}
              </Button>
            ) : back.kind === "elsewhere" ? (
              <Button
                as={Link}
                href={back.href}
                size="sm"
                variant="flat"
                radius="md"
                className="min-h-9"
              >
                {back.where === "settings"
                  ? t("takeBack.settings")
                  : t("takeBack.agent")}
              </Button>
            ) : back.kind === "with-source" ? (
              <Button
                as={Link}
                href={`${BASE}?focus=${encodeURIComponent(back.ruleId)}`}
                size="sm"
                variant="flat"
                radius="md"
                className="min-h-9"
              >
                {t("takeBack.source")}
              </Button>
            ) : null}
          </div>
        }
      />
    </div>
  );
}

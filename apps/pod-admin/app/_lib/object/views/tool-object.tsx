"use client";

/**
 * One integration (a `tools` row) — drawn by `/open/tool/:id`.
 *
 * A tool is part of a capability through its `member_of` edge, and that
 * capability's page is where it is turned on and seen running. So a tool
 * whose capability the reader can see opens THAT page (`tools.get` →
 * `capabilityId`, floored server-side), replacing this address so Back does
 * not land on a redirect. A tool in no capability the reader can see is drawn
 * here: on or off (its `approved`, the flag the run gate reads), where it
 * applies, and the skills that use it, each a door to its own page. It has no
 * run history here: the tool lens reads skill runs, and a tool's own calls
 * belong to the capability that wraps it.
 */

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { humanizeToken } from "@synap-core/types/vocabulary";
import { trpc } from "../../../../lib/trpc";
import { ExitLink } from "../../../../lib/exit-link";
import { openIn } from "../../../../lib/open-in";
import { useT } from "../../../../lib/i18n/locale-provider";
import {
  ResourceRow,
  ResourceRowEmpty,
} from "../../../(admin)/components/resource-row";
import { TOOLS_CATALOGS } from "../../../(admin)/tools/_lib/copy";
import { approvedStatus } from "../../../(admin)/tools/_lib/tool-status";
import { toolWhere } from "../../../(admin)/tools/_lib/tools-model";
import { kindIcon } from "../kind-icon";
import { couldNotLoad, loadFailure } from "../load-failure";
import { useReauthOnUnauthorized } from "../use-reauth";
import type { ObjectFrame } from "./object-frame";

const SkillIcon = kindIcon("skill");

export function ToolObject({ id, frame }: { id: string; frame: ObjectFrame }) {
  const t = useT(TOOLS_CATALOGS);
  const router = useRouter();
  const query = trpc.tools.get.useQuery({ id }, { retry: false });
  const workspaceId = query.data?.tool.workspaceId ?? null;
  const spaces = trpc.workspaces.list.useQuery(undefined, {
    enabled: Boolean(workspaceId),
    retry: false,
  });
  useReauthOnUnauthorized(query.error);
  const capabilityId = query.data?.capabilityId ?? null;
  useEffect(() => {
    if (capabilityId)
      router.replace(
        openIn({ kind: "object", objectKind: "capability", id: capabilityId })
          .href
      );
  }, [capabilityId, router]);

  if (query.isLoading || capabilityId) return frame.loading(t("loading"));
  const tool = query.data?.tool;
  const fail = loadFailure(query.error, "Tool");
  if (fail || !tool) {
    return frame.failure({
      kind: "tool",
      id,
      failure: fail ?? couldNotLoad("Tool"),
    });
  }

  const usedBy = query.data?.skills ?? [];
  const spaceName = (wsId: string) =>
    (spaces.data ?? []).find((s) => s.id === wsId)?.name;

  return frame.object({
    header: {
      kind: "tool",
      title: tool.name,
      summary: tool.description?.trim() || undefined,
      status: approvedStatus(tool),
      breadcrumb: frame.breadcrumb?.(tool.name),
      secondaryActions: (
        <ExitLink
          exit={openIn({ kind: "objectInApp", objectKind: "tool", id })}
          label={t("openInApp")}
        />
      ),
    },
    facts: [
      {
        label: t("fact.space"),
        value: toolWhere(
          {
            scope: workspaceId ? "workspace" : "pod",
            workspaceId,
          },
          spaceName
        ),
      },
      { label: t("fact.kind"), value: humanizeToken(tool.kind) },
    ],
    children: (
      <section className="flex flex-col gap-2">
        <h2 className="text-[13px] font-medium text-foreground">
          {t("tool.usedBy")}
        </h2>
        {usedBy.length === 0 ? (
          <ResourceRowEmpty message={t("tool.unused")} />
        ) : (
          <div className="-mx-2 divide-y divide-foreground/[0.05]">
            {usedBy.map((s) => (
              <ResourceRow
                key={s.id}
                Icon={SkillIcon}
                primary={s.name}
                secondary={humanizeToken(s.kind)}
                status={approvedStatus(s)}
                onSelect={() =>
                  router.push(
                    openIn({ kind: "object", objectKind: "skill", id: s.id })
                      .href
                  )
                }
                wrap
              />
            ))}
          </div>
        )}
      </section>
    ),
    advanced: {
      ids: [
        { label: t("id.tool"), value: tool.id },
        ...(workspaceId ? [{ label: t("id.space"), value: workspaceId }] : []),
      ],
      raw: tool,
    },
  });
}

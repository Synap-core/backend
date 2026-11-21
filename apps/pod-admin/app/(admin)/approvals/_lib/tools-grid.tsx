"use client";

/**
 * Approvals › By tool — the agents × tools grid (lane W3, decision b387ca45
 * §5), read from the approval rows themselves (`toolsGrid`,
 * `tool-approvals-model.ts`): one row per who (every AI, a class of agents,
 * each agent with an approval of its own), one column per tool those rows
 * name, each cell the verdict of that who's rows on that tool (on the whole
 * tool or one of its actions, anywhere), or "Mixed" when they differ. An
 * empty cell is no approval of its own: that agent follows every AI's.
 *
 * Every name is a door: an agent to its page, a tool to its page (where its
 * rows are set and taken back), a cell to the same tool page. It narrows with
 * the page's one filter row (the rows it is given are already filtered).
 * The work grid (agents × each space's processes) is `?view=work`.
 */

import Link from "next/link";
import { humanizePrincipal } from "@synap-core/types/governance-rules";
import {
  resolveActionRunModeLabel,
  resolveMatrixMarkLabel,
} from "@synap-core/types/vocabulary";
import { agentHref } from "../../../../lib/console-nav";
import { useT } from "../../../../lib/i18n/locale-provider";
import {
  gridCellKey,
  type GridMark,
  type GridPrincipal,
  type ToolsGrid,
} from "../../../../lib/governance-rules/tool-approvals-model";
import { approvalToolName } from "../../../../lib/governance-rules/approvals-model";
import { StatusPill } from "../../components/status-pill";
import { capabilityPageHref } from "../../tools/_lib/tools-model";
import { MODE_ICON, MODE_TONE } from "./approval-line";
import { en, fr } from "./copy";

const CATALOGS = { en, fr };

function markWords(mark: GridMark): string {
  return mark === "mixed"
    ? resolveMatrixMarkLabel("mixed")
    : resolveActionRunModeLabel(mark);
}

function PrincipalName({
  p,
  listHref,
}: {
  p: GridPrincipal;
  listHref: (key: string) => string;
}) {
  const t = useT(CATALOGS);
  const name =
    p.kind === "any" ? t("toolsGrid.everyAi") : humanizePrincipal(p.sample);
  return (
    <Link
      href={p.agentUserId ? agentHref(p.agentUserId) : listHref(p.key)}
      className="text-[12.5px] font-medium text-foreground underline-offset-2 hover:underline"
    >
      {name}
    </Link>
  );
}

export function ToolsGridView({
  grid,
  toolName,
  listHref,
}: {
  grid: ToolsGrid;
  toolName: (pattern: string) => string | null;
  /** The list narrowed to one who (`?agent=`). */
  listHref: (agentKey: string) => string;
}) {
  const t = useT(CATALOGS);
  if (grid.principals.length === 0 || grid.tools.length === 0) {
    return (
      <p
        data-tools-grid-empty=""
        className="px-1 py-6 text-[12.5px] text-foreground/65"
      >
        {t("toolsGrid.empty")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] text-foreground/65">{t("toolsGrid.why")}</p>
      <div className="-mx-1 overflow-x-auto">
        <table
          data-tools-grid=""
          className="min-w-full border-separate border-spacing-0 text-left"
        >
          <thead>
            <tr>
              <th
                scope="col"
                className="sticky left-0 z-10 bg-background px-2 py-2 text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/65"
              >
                {t("toolsGrid.who")}
              </th>
              {grid.tools.map((tool) => {
                const name =
                  tool.name ?? approvalToolName(tool.pattern, toolName);
                return (
                  <th
                    key={tool.key}
                    scope="col"
                    className="min-w-[132px] px-2 py-2 align-bottom text-[12px] font-medium text-foreground"
                  >
                    {tool.toolId ? (
                      <Link
                        href={capabilityPageHref(tool.toolId)}
                        data-grid-tool={tool.toolId}
                        className="underline-offset-2 hover:underline"
                      >
                        {name}
                      </Link>
                    ) : (
                      name
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {grid.principals.map((p) => (
              <tr key={p.key} data-grid-principal={p.key}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 border-t border-foreground/[0.06] bg-background px-2 py-2 font-normal"
                >
                  <PrincipalName p={p} listHref={listHref} />
                </th>
                {grid.tools.map((tool) => {
                  const cell = grid.cells.get(gridCellKey(p.key, tool.key));
                  const label = cell?.mark ? markWords(cell.mark) : null;
                  const pill = cell?.mark ? (
                    <StatusPill
                      kind={
                        cell.mark === "mixed" ? "unknown" : MODE_TONE[cell.mark]
                      }
                      icon={
                        cell.mark === "mixed" ? undefined : MODE_ICON[cell.mark]
                      }
                      label={label ?? ""}
                    />
                  ) : (
                    <span
                      className="text-[12px] text-foreground/45"
                      aria-label={t("toolsGrid.follows")}
                      title={t("toolsGrid.follows")}
                    >
                      —
                    </span>
                  );
                  return (
                    <td
                      key={tool.key}
                      data-grid-cell={cell?.mark ?? "none"}
                      className="border-t border-foreground/[0.06] px-2 py-2"
                    >
                      {tool.toolId && cell ? (
                        <Link
                          href={capabilityPageHref(tool.toolId)}
                          aria-label={t("toolsGrid.cellAria", {
                            who:
                              p.kind === "any"
                                ? t("toolsGrid.everyAi")
                                : humanizePrincipal(p.sample),
                            mode: label ?? "",
                          })}
                          className="inline-flex min-h-8 items-center"
                        >
                          {pill}
                        </Link>
                      ) : (
                        pill
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

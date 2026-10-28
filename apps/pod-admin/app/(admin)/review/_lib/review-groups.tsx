"use client";

/**
 * Review, grouped (founder B-1, B-4, 27 Oct 2026). The page's rows drawn one
 * of four ways — the "Group by" control at the top picks which:
 *
 *   Package  the decision each item asks, in the fixed order (stakes first).
 *            Each package is a section: its count, its oldest age, its ONE
 *            action, and a layout switch where it has a second layout.
 *   Work     each session with everything it waits on (the joined view, B-5).
 *   Agent    each agent with what it asks for.
 *   Time     one list, newest first (the server's order).
 *
 * Grouping is decided in `review-rows.ts` (pure, tested); this file only
 * draws it, with the console's own parts: `SectionCard`, `ResourceRow` (via
 * the page's `renderRow`), `FilterChips`, HeroUI `Card`/`Button`. Every
 * decision still opens where it always did — the dock or drawer
 * (`review-drawer.tsx`), or inline for How things work's diff.
 */

import { useState, type ReactNode } from "react";
import { Button, Card, CardBody, Chip } from "@heroui/react";
import { Check, MessageSquare, Repeat } from "lucide-react";
import {
  REVIEW_PACKAGE_LAYOUTS,
  type ReviewLayout,
  type ReviewPackage,
} from "@synap-core/types/proposals/review-package";
import {
  resolveObjectNoun,
  resolveReviewLayoutLabel,
  resolveReviewPackageLabel,
} from "@synap-core/types/vocabulary";
import { formatRelative } from "../../../../lib/format";
import { openIn } from "../../../../lib/open-in";
import { SectionCard } from "../../components/section-card";
import { ResourceRow } from "../../components/resource-row";
import { FilterChips } from "../../components/filter-chips";
import { kindIcon, kindLabel } from "../../../_lib/object/kind-icon";
import { Pill } from "../../../_lib/object/provenance-chips";
import {
  agentGroups,
  itemCount,
  keepAllOf,
  oldestAt,
  packageGroups,
  sessionGroups,
  type RowGroup,
  type ReviewRow,
} from "./review-rows";

/** Rows a section shows before "Show all" (ui-composition §4). */
const ROW_CAP = 8;
/** Session or agent names a hand-off line names before "+N more". */
const NAME_CAP = 12;

/**
 * What each package asks of the person — the line under its name. Product
 * copy (a sentence), not vocabulary: the package NAME comes from the door.
 */
const PACKAGE_ASK: Readonly<Record<ReviewPackage, string>> = {
  questions: "an agent waits on your answer",
  access: "who may act or see · one at a time",
  releases: "go or no-go on a deploy",
  "how-things-work": "rules and playbooks agents follow · read each",
  "data-changes": "changes to your records",
  "hand-offs": "work handed to an agent",
  knowledge: "what agents learned · skim, keep, reject the odd one",
  bookkeeping: "agents' notes on their own sessions",
};

/** The verb of a package's one "all" action. */
const KEEP_VERB: Readonly<Record<ReviewPackage, string | null>> = {
  questions: null,
  access: null,
  releases: null,
  "how-things-work": null,
  "data-changes": "Approve",
  "hand-offs": "Allow",
  knowledge: "Keep",
  bookkeeping: "Keep",
};

/** What the page hands the groups: how to draw a row and act on rows. */
export interface ReviewGroupActions {
  /** The page's row (`ReviewListRow`), with its selection wired. */
  renderRow: (row: ReviewRow, opts?: { showPackage?: boolean }) => ReactNode;
  /** Open a row's decision (dock / drawer). */
  open: (row: ReviewRow) => void;
  /** Approve these rows in one batch (`proposals.batchApprove`). */
  keep: (rows: ReviewRow[]) => void;
  /** A batch is running. */
  busy: boolean;
  /** A row's decision drawn in place (How things work's diff layout). */
  renderInline: (row: ReviewRow) => ReactNode;
  /** "Always for this agent" — a governance rule, through the human door. */
  alwaysForAgent: (group: RowGroup) => void;
}

function metaLine(rows: readonly ReviewRow[], tail?: string): string {
  const count = itemCount(rows);
  const oldest = oldestAt(rows);
  return [
    `${count} waiting`,
    oldest ? `oldest ${formatRelative(oldest, { empty: "" })}` : null,
    tail,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A list of rows, capped, with "Show all N". */
function CappedRows({
  rows,
  render,
}: {
  rows: readonly ReviewRow[];
  render: (row: ReviewRow) => ReactNode;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, ROW_CAP);
  return (
    <div className="divide-y divide-foreground/[0.05]">
      {shown.map(render)}
      {rows.length > ROW_CAP && (
        <div className="px-3 py-2">
          <Button size="sm" variant="light" onPress={() => setAll((v) => !v)}>
            {all ? "Show fewer" : `Show all ${rows.length}`}
          </Button>
        </div>
      )}
    </div>
  );
}

/** The one "all" button of a set of rows, or nothing when none can be batched. */
function KeepAllButton({
  verb,
  rows,
  actions,
  primary = true,
}: {
  verb: string;
  rows: readonly ReviewRow[];
  actions: ReviewGroupActions;
  primary?: boolean;
}) {
  const keep = keepAllOf(rows);
  if (keep.rows.length === 0) return null;
  const n = itemCount(keep.rows);
  return (
    <Button
      size="sm"
      color={primary ? "primary" : "default"}
      variant={primary ? "solid" : "flat"}
      startContent={<Check className="h-3.5 w-3.5" aria-hidden />}
      isDisabled={actions.busy}
      onPress={() => actions.keep(keep.rows)}
    >
      {keep.left > 0 ? `${verb} ${n} of these` : `${verb} all ${n}`}
    </Button>
  );
}

// ── Group by Package ─────────────────────────────────────────────────────────

function PackageSection({
  pkg,
  rows,
  layout,
  onLayout,
  actions,
}: {
  pkg: ReviewPackage;
  rows: ReviewRow[];
  layout: ReviewLayout;
  onLayout: (layout: ReviewLayout) => void;
  actions: ReviewGroupActions;
}) {
  const layouts = REVIEW_PACKAGE_LAYOUTS[pkg];
  const verb = KEEP_VERB[pkg];
  const first = rows[0];
  const oneAction =
    verb && layout !== "by-agent" ? (
      <KeepAllButton verb={verb} rows={rows} actions={actions} />
    ) : !verb && first && first.detail && first.detail.kind !== "open" ? (
      <Button size="sm" variant="flat" onPress={() => actions.open(first)}>
        {pkg === "questions" ? "Answer the first" : "Review the first"}
      </Button>
    ) : null;
  return (
    <SectionCard
      title={resolveReviewPackageLabel(pkg)}
      hint={metaLine(rows, PACKAGE_ASK[pkg])}
      actions={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {oneAction}
          {layouts.length > 1 && (
            <FilterChips
              ariaLabel={`${resolveReviewPackageLabel(pkg)} layout`}
              className=""
              active={layout}
              chips={layouts.map((l) => ({
                key: l,
                label: resolveReviewLayoutLabel(l),
              }))}
              onSelect={onLayout}
            />
          )}
        </div>
      }
    >
      <PackageBody pkg={pkg} rows={rows} layout={layout} actions={actions} />
    </SectionCard>
  );
}

function PackageBody({
  pkg,
  rows,
  layout,
  actions,
}: {
  pkg: ReviewPackage;
  rows: ReviewRow[];
  layout: ReviewLayout;
  actions: ReviewGroupActions;
}) {
  switch (layout) {
    case "cards":
      return <AskCards rows={rows} actions={actions} />;
    case "gallery":
      return <Gallery rows={rows} actions={actions} />;
    case "diff":
      return <DiffPane rows={rows} actions={actions} />;
    case "by-agent":
      return <HandOffsByAgent rows={rows} actions={actions} />;
    case "by-session":
      return (
        <FoldedBySession
          rows={rows}
          actions={actions}
          verb={KEEP_VERB[pkg] ?? "Keep"}
        />
      );
    case "list":
      return <CappedRows rows={rows} render={(r) => actions.renderRow(r)} />;
  }
}

/** Questions as cards: the question, where it comes from, its one verb. */
function AskCards({
  rows,
  actions,
}: {
  rows: ReviewRow[];
  actions: ReviewGroupActions;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 px-1 pb-1 sm:grid-cols-2">
      {rows.map((row) => {
        const opens = row.detail !== null && row.detail.kind !== "open";
        return (
          <Card
            key={row.key}
            data-row-id={row.key}
            shadow="none"
            radius="md"
            className="bg-content1 ring-1 ring-inset ring-foreground/10"
          >
            <CardBody className="flex flex-col gap-2 p-4">
              <p className="text-[13.5px] font-medium leading-5 text-foreground">
                {row.title}
              </p>
              <p className="text-[12px] text-foreground/65">
                {[
                  row.reason,
                  row.sessionTitle ?? row.where,
                  formatRelative(row.occurredAt, { empty: "" }),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <div>
                {opens ? (
                  <Button
                    size="sm"
                    color="primary"
                    startContent={
                      <MessageSquare className="h-3.5 w-3.5" aria-hidden />
                    }
                    onPress={() => actions.open(row)}
                  >
                    {row.detail?.kind === "ask" ? "Answer" : "Review"}
                  </Button>
                ) : (
                  actions.renderRow(row)
                )}
              </div>
            </CardBody>
          </Card>
        );
      })}
    </div>
  );
}

/** Knowledge as a card gallery: its kind, the claim, where it was learned. */
function Gallery({
  rows,
  actions,
}: {
  rows: ReviewRow[];
  actions: ReviewGroupActions;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, ROW_CAP * 2);
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-1 gap-2.5 px-1 pb-1 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((row) => {
          const Icon = kindIcon(row.nounKind);
          return (
            <Card
              key={row.key}
              data-row-id={row.key}
              isPressable={row.detail !== null && row.detail.kind !== "open"}
              onPress={() => actions.open(row)}
              shadow="none"
              radius="md"
              className="bg-content1 text-left ring-1 ring-inset ring-foreground/10"
            >
              <CardBody className="flex flex-col gap-1.5 p-3">
                <Chip
                  size="sm"
                  radius="sm"
                  variant="flat"
                  startContent={<Icon className="ml-1 h-3 w-3" aria-hidden />}
                >
                  {kindLabel(row.nounKind)}
                </Chip>
                <p className="line-clamp-3 text-[13px] font-medium leading-5 text-foreground">
                  {row.title}
                </p>
                <p className="truncate text-[12px] text-foreground/65">
                  {[
                    row.sessionTitle ?? row.where,
                    row.count > 1 ? `${row.count} grouped` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </CardBody>
            </Card>
          );
        })}
      </div>
      {rows.length > shown.length || all ? (
        <div className="px-1">
          <Button size="sm" variant="light" onPress={() => setAll((v) => !v)}>
            {all ? "Show fewer" : `Show all ${rows.length}`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** How things work: the list on one side, the picked item's change beside it. */
function DiffPane({
  rows,
  actions,
}: {
  rows: ReviewRow[];
  actions: ReviewGroupActions;
}) {
  const readable = rows.filter(
    (r) => r.detail !== null && r.detail.kind === "proposal"
  );
  const [pickedKey, setPicked] = useState<string | null>(null);
  const picked =
    readable.find((r) => r.key === pickedKey) ?? readable[0] ?? null;
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <div
        role="listbox"
        aria-label="Rules and playbooks to read"
        className="flex flex-col gap-1"
      >
        {rows.map((row) => {
          const Icon = kindIcon(row.nounKind);
          const on = picked?.key === row.key;
          return (
            <button
              key={row.key}
              type="button"
              role="option"
              aria-selected={on}
              data-row-id={row.key}
              onClick={() =>
                readable.includes(row) ? setPicked(row.key) : actions.open(row)
              }
              className={[
                "flex min-h-10 items-center gap-2 rounded-md px-3 py-2 text-left text-[13px]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                on
                  ? "bg-foreground/[0.08] text-foreground ring-1 ring-inset ring-foreground/15"
                  : "text-foreground/80 hover:bg-content2/50",
              ].join(" ")}
            >
              <Icon
                className="h-4 w-4 shrink-0 text-foreground/50"
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate">{row.title}</span>
            </button>
          );
        })}
      </div>
      <div className="min-w-0 rounded-lg bg-content1 px-6 py-4 ring-1 ring-inset ring-foreground/10">
        {picked ? (
          actions.renderInline(picked)
        ) : (
          <p className="text-[12.5px] text-foreground/65">
            Pick one to read its change.
          </p>
        )}
      </div>
    </div>
  );
}

/** Names, capped, then "+N more". */
function nameList(names: readonly string[]): string[] {
  const unique = [...new Set(names)];
  return unique.length > NAME_CAP
    ? [...unique.slice(0, NAME_CAP), `+${unique.length - NAME_CAP} more`]
    : unique;
}

/** Hand-offs, one block per agent: one decision — may it take these? */
function HandOffsByAgent({
  rows,
  actions,
}: {
  rows: ReviewRow[];
  actions: ReviewGroupActions;
}) {
  return (
    <div className="flex flex-col gap-3">
      {agentGroups(rows).map((g) => (
        <div
          key={g.id ?? "none"}
          className="flex flex-col gap-2 rounded-lg bg-content1 p-3 ring-1 ring-inset ring-foreground/10"
        >
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 text-[13.5px] font-medium text-foreground">
              {g.title
                ? `${g.title} takes ${itemCount(g.rows)}`
                : `${itemCount(g.rows)} hand-offs, from several agents`}
            </p>
            <KeepAllButton verb="Allow" rows={g.rows} actions={actions} />
            {g.id && (
              <Button
                size="sm"
                variant="flat"
                startContent={<Repeat className="h-3.5 w-3.5" aria-hidden />}
                isDisabled={actions.busy}
                onPress={() => actions.alwaysForAgent(g)}
              >
                Always for this agent
              </Button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {nameList(g.rows.map((r) => r.sessionTitle ?? r.title)).map(
              (name) => (
                <Chip key={name} size="sm" radius="sm" variant="flat">
                  {name}
                </Chip>
              )
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Bookkeeping, folded per session: "5 notes on <session>". */
function FoldedBySession({
  rows,
  actions,
  verb,
}: {
  rows: ReviewRow[];
  actions: ReviewGroupActions;
  verb: string;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const groups = sessionGroups(rows);
  const SessionIcon = kindIcon("session");
  return (
    <div className="divide-y divide-foreground/[0.05]">
      {groups.map((g) => {
        const key = g.id ?? "none";
        const expanded = openKey === key;
        return (
          <div key={key}>
            {/* The canonical row, `wrap`: on a phone the buttons drop under
                the name instead of squeezing it to one letter (finding
                cf73140d). */}
            <ResourceRow
              wrap
              Icon={SessionIcon}
              primary={
                g.title ??
                (g.id ? resolveObjectNoun("session") : "Not in a session")
              }
              actions={
                <div className="flex items-center gap-2">
                  <Chip
                    size="sm"
                    radius="sm"
                    variant="flat"
                    className="tabular"
                  >
                    {itemCount(g.rows)}
                  </Chip>
                  <Button
                    size="sm"
                    variant="light"
                    aria-expanded={expanded}
                    onPress={() => setOpenKey(expanded ? null : key)}
                  >
                    {expanded ? "Hide them" : "See them"}
                  </Button>
                  <KeepAllButton
                    verb={verb}
                    rows={g.rows}
                    actions={actions}
                    primary={false}
                  />
                </div>
              }
            />
            {expanded && (
              <div className="ml-6 border-l border-foreground/[0.08]">
                <CappedRows
                  rows={g.rows}
                  render={(r) => actions.renderRow(r)}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Group by Work / Agent / Time ─────────────────────────────────────────────

/** One session or agent block: its rows, each saying its package. */
function BlockSection({
  group,
  noneTitle,
  door,
  actions,
}: {
  group: RowGroup;
  noneTitle: string;
  door?: ReactNode;
  actions: ReviewGroupActions;
}) {
  const kinds = [...new Set(group.rows.map((r) => r.package))]
    .map(resolveReviewPackageLabel)
    .join(", ");
  return (
    <SectionCard
      title={group.title ?? noneTitle}
      hint={metaLine(group.rows, kinds)}
      actions={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {door}
          <KeepAllButton
            verb="Approve"
            rows={group.rows}
            actions={actions}
            primary={false}
          />
        </div>
      }
    >
      <CappedRows
        rows={group.rows}
        render={(r) => actions.renderRow(r, { showPackage: true })}
      />
    </SectionCard>
  );
}

export function ReviewGroups({
  rows,
  groupBy,
  layoutOf,
  onLayout,
  actions,
}: {
  rows: ReviewRow[];
  groupBy: "package" | "work" | "agent" | "time";
  layoutOf: (pkg: ReviewPackage) => ReviewLayout;
  onLayout: (pkg: ReviewPackage, layout: ReviewLayout) => void;
  actions: ReviewGroupActions;
}) {
  if (groupBy === "time") {
    return (
      <section className="rounded-lg bg-foreground/[0.02] ring-1 ring-inset ring-foreground/10">
        <CappedRows
          rows={rows}
          render={(r) => actions.renderRow(r, { showPackage: true })}
        />
      </section>
    );
  }
  if (groupBy === "work") {
    return (
      <div className="flex flex-col gap-4">
        {sessionGroups(rows).map((g) => (
          <BlockSection
            key={g.id ?? "none"}
            group={g}
            noneTitle="Not in a session"
            door={
              g.id ? (
                <Pill
                  exit={openIn({
                    kind: "object",
                    objectKind: "session",
                    id: g.id,
                  })}
                  title={resolveObjectNoun("session")}
                >
                  Open session
                </Pill>
              ) : undefined
            }
            actions={actions}
          />
        ))}
      </div>
    );
  }
  if (groupBy === "agent") {
    return (
      <div className="flex flex-col gap-4">
        {agentGroups(rows).map((g) => (
          <BlockSection
            key={g.id ?? "none"}
            group={g}
            noneTitle="Not from one agent"
            actions={actions}
          />
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {packageGroups(rows).map((g) => (
        <PackageSection
          key={g.package}
          pkg={g.package}
          rows={g.rows}
          layout={layoutOf(g.package)}
          onLayout={(l) => onLayout(g.package, l)}
          actions={actions}
        />
      ))}
    </div>
  );
}

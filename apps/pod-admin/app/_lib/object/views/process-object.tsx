"use client";

/**
 * One process (a playbook seen whole), the one object page: drawn by
 * `/processes/[id]` in the console and by `/open/playbook/:id` in the
 * receiver card (`ObjectFrame`). It replaces the template page.
 *
 * Reads: `playbooks.process({ playbookId })`, the pod's ONE process read
 * (`@synap-core/types/processes` `ProcessRead`, user-floored). The blocks
 * come in the leaf's order (`blocksToDraw`); an empty block is omitted, a
 * block whose read failed says so. The space's name comes from the reader's
 * own spaces; only a pod admin also asks the all-spaces door.
 *
 * Decision D4 (founder, 16 Nov 2026): pod admin shows the definition, its
 * needs, automations and who may run it, and the COUNTS of its runs, each a
 * door to the desktop app where runs are worked. No run list here
 * (CLAUDE.md: pod admin is not a work surface).
 *
 * Acts: Pause / Turn on (`playbooks.update` status, governed: an agent-owned
 * space proposes) and Archive. Authoring stays in the app ("Open in app").
 */

import { addToast, Button } from "@heroui/react";
import Link from "next/link";
import { ListChecks, Zap } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import type { ProcessBlock, ProcessRead } from "@synap-core/types/processes";
import { consolePath } from "@synap-core/types/console";
import type { TFunction } from "@synap-core/types/i18n";
import {
  buildObjectActionTitle,
  humanizeToken,
  resolveActionLabel,
  resolveObjectNoun,
  resolveObjectNounPlural,
} from "@synap-core/types/vocabulary";
import { trpc } from "../../../../lib/trpc";
import { navHref } from "../../../../lib/console-nav";
import { openIn } from "../../../../lib/open-in";
import { ExitLink } from "../../../../lib/exit-link";
import { useConsoleLocale, useT } from "../../../../lib/i18n/locale-provider";
import { ResourceRow } from "../../../(admin)/components/resource-row";
import { SectionCard } from "../../../(admin)/components/section-card";
import { StatusPill } from "../../../(admin)/components/status-pill";
import { statusPillFor } from "../../../(admin)/components/status-tone";
import { templateSummary } from "../../../(admin)/processes/_lib/summary";
import { CATALOGS } from "../../../(admin)/processes/_lib/copy";
import {
  blocksToDraw,
  blockUnavailable,
  countDoors,
  countExitTarget,
  installedFromWords,
  needRow,
  preApprovalWords,
  processHealthPill,
  runnerLabel,
  stepGateLabel,
  stepUses,
  type Words,
} from "../../../(admin)/processes/_lib/process-page";
import { couldNotLoad, loadFailure } from "../load-failure";
import { useReauthOnUnauthorized } from "../use-reauth";
import type { ObjectFrame } from "./object-frame";

export function ProcessObject({
  id,
  frame,
  viewerIsPodAdmin,
  onArchived,
}: {
  id: string;
  frame: ObjectFrame;
  /** Offers only: a pod admin also names spaces they are not a member of. */
  viewerIsPodAdmin: boolean;
  /** After an archive lands (not when it was proposed). */
  onArchived?: () => void;
}) {
  const t = useT(CATALOGS);
  const locale = useConsoleLocale();
  const say = (w: Words) => t(w.key, w.params as never);
  const utils = trpc.useUtils();
  const query = trpc.playbooks.process.useQuery(
    { playbookId: id },
    { retry: false }
  );
  const workspaceId = query.data?.playbook.workspaceId ?? null;
  const mySpaces = trpc.workspaces.list.useQuery(undefined, {
    enabled: Boolean(workspaceId),
    staleTime: 60_000,
    retry: false,
  });
  const allSpaces = trpc.workspaces.adminListAll.useQuery(undefined, {
    enabled: viewerIsPodAdmin && Boolean(workspaceId),
    staleTime: 60_000,
    retry: false,
  });
  const update = trpc.playbooks.update.useMutation();
  const archive = trpc.playbooks.archive.useMutation();
  useReauthOnUnauthorized(query.error);

  const spaceName = useMemo(() => {
    if (!workspaceId) return t("list.allSpaces");
    return (
      [...(mySpaces.data ?? []), ...(allSpaces.data ?? [])].find(
        (s) => s.id === workspaceId
      )?.name ?? t("list.aSpace")
    );
  }, [workspaceId, mySpaces.data, allSpaces.data, t]);

  if (query.isLoading) return frame.loading(t("loading"));
  const read = query.data;
  const noun = resolveObjectNoun("playbook");
  const fail = loadFailure(query.error, noun);
  if (fail || !read) {
    return frame.failure({
      kind: "playbook",
      id,
      failure: fail ?? couldNotLoad(noun),
    });
  }
  const def = read.playbook;
  // Named, not inlined: `exit-door.test.ts` reads "Pending: x." as a dead
  // control naming a missing procedure.
  const archiving = archive.isPending;
  const archiveLabel = buildObjectActionTitle({
    action: "archive",
    objectKind: "playbook",
  });
  const desktop = openIn({ kind: "objectInApp", objectKind: "playbook", id });
  const week = countDoors(read.runs.counts);

  async function setStatus(next: "paused" | "active") {
    try {
      const out = await update.mutateAsync({ id, status: next });
      addToast({
        title:
          out.status === "proposed"
            ? t("action.proposed")
            : resolveActionLabel(
                next === "paused" ? "pause" : "turn_on",
                "past"
              ),
        color: "default",
      });
      if (out.status !== "proposed") {
        await utils.playbooks.process.invalidate({ playbookId: id });
      }
    } catch (err) {
      addToast({
        title: t("action.failed"),
        description: err instanceof Error ? err.message : undefined,
        color: "danger",
      });
    }
  }

  const statusAct =
    def.status === "active" ? (
      <Button
        size="sm"
        variant="flat"
        radius="md"
        isLoading={update.isPending}
        onPress={() => void setStatus("paused")}
      >
        {resolveActionLabel("pause", "imperative")}
      </Button>
    ) : def.status === "paused" || def.status === "draft" ? (
      <Button
        size="sm"
        variant="flat"
        radius="md"
        isLoading={update.isPending}
        onPress={() => void setStatus("active")}
      >
        {resolveActionLabel("turn_on", "imperative")}
      </Button>
    ) : null;

  const reviewUpdate =
    def.updateAvailable && def.installedFrom ? (
      <Button
        as={Link}
        href={`${navHref("marketplace")}/updates/${encodeURIComponent(def.installedFrom.packageSlug)}`}
        size="sm"
        variant="flat"
        radius="md"
      >
        {t("action.reviewUpdate")}
      </Button>
    ) : null;

  const spaceHref = workspaceId
    ? consolePath({ page: "space", id: workspaceId })
    : null;

  const thisWeek =
    week.doors.length === 0 ? (
      week.unmeasured ? (
        t("count.unmeasured")
      ) : (
        t("count.none")
      )
    ) : (
      <span className="flex flex-wrap gap-x-3 gap-y-1">
        {week.doors.map((door) => (
          <ExitLink
            key={door.key}
            exit={openIn(countExitTarget(door.key, id, read.health))}
            label={say(door.words)}
          />
        ))}
      </span>
    );

  const blocks = blocksToDraw(read);
  return frame.object({
    header: {
      kind: "playbook",
      title: def.name,
      summary: templateSummary(def.description, null),
      status: processHealthPill(read.health, locale),
      breadcrumb: frame.breadcrumb?.(def.name),
      primaryAction: <ExitLink exit={desktop} label={t("action.openInApp")} />,
      secondaryActions:
        reviewUpdate || statusAct ? (
          <>
            {reviewUpdate}
            {statusAct}
          </>
        ) : undefined,
    },
    facts: [
      {
        label: resolveObjectNoun("workspace"),
        value: spaceHref ? (
          <Link href={spaceHref} className="hover:underline">
            {spaceName}
          </Link>
        ) : (
          spaceName
        ),
      },
      { label: t("fact.installedFrom"), value: say(installedFromWords(def)) },
      { label: t("fact.version"), value: String(def.version) },
      { label: t("fact.thisWeek"), value: thisWeek },
    ],
    factColumns: 4,
    children: (
      <div className="flex flex-col gap-6">
        {/* REASSURE: why the counts open elsewhere (D4). */}
        <p className="-mt-3 text-[12.5px] text-foreground/65">
          {t("count.reassure")}
        </p>
        {blocks.map((block) => (
          <Block key={block} block={block} read={read} t={t} />
        ))}
        <SectionCard
          title={t("access.title")}
          actions={
            <Button
              as={Link}
              href={navHref("governance")}
              size="sm"
              variant="light"
              radius="md"
            >
              {t("access.door")}
            </Button>
          }
        >
          <p className="text-[13px] text-foreground/85">
            {say(preApprovalWords(def, read))}
          </p>
        </SectionCard>
      </div>
    ),
    advanced: {
      ids: [
        { label: t("ids.process"), value: def.id },
        ...(def.workspaceId
          ? [{ label: t("ids.space"), value: def.workspaceId }]
          : []),
      ],
      raw: read,
    },
    danger:
      def.status === "archived"
        ? []
        : [
            {
              key: "archive",
              label: archiveLabel,
              description: t("archive.description"),
              consequence: t("archive.consequence"),
              confirmLabel: archiveLabel,
              confirmColor: "warning",
              isPending: archiving,
              onConfirm: async () => {
                try {
                  const out = await archive.mutateAsync({ id });
                  if (out.status === "proposed") {
                    addToast({
                      title: t("archive.proposed"),
                      color: "default",
                    });
                    return;
                  }
                  addToast({
                    title: buildObjectActionTitle({
                      action: "archive",
                      objectKind: "playbook",
                      mood: "past",
                    }),
                    color: "default",
                  });
                  await Promise.all([
                    utils.playbooks.process.invalidate({ playbookId: id }),
                    utils.playbooks.processes.invalidate(),
                  ]);
                  onArchived?.();
                } catch (err) {
                  addToast({
                    title: t("archive.failed"),
                    description: err instanceof Error ? err.message : undefined,
                    color: "danger",
                  });
                  throw err;
                }
              },
            },
          ],
  });
}

type T = TFunction<typeof CATALOGS.en>;

/** One block of the process, in the leaf's order. */
function Block({
  block,
  read,
  t,
}: {
  block: ProcessBlock;
  read: ProcessRead;
  t: T;
}) {
  const locale = useConsoleLocale();
  const failed = blockUnavailable(read, block);
  const explain = (
    <p className="text-[12.5px] text-foreground/65">{t("block.unavailable")}</p>
  );
  const rows = (children: ReactNode) => (
    <div className="-mx-2 divide-y divide-foreground/[0.05]">{children}</div>
  );
  switch (block) {
    case "when":
      return (
        <SectionCard
          title={resolveObjectNounPlural("automation")}
          count={failed ? null : read.when.automations.length}
        >
          {failed ? (
            explain
          ) : (
            <div className="flex flex-col gap-2">
              {read.when.automations.length > 0 &&
                rows(
                  read.when.automations.map((a) => (
                    <AutomationRow key={a.id} automation={a} />
                  ))
                )}
              {read.when.workers.length > 0 && (
                <p className="text-[12.5px] text-foreground/65">
                  {t("when.workers", { n: read.when.workers.length })}
                </p>
              )}
              {read.when.manualStart && (
                <p className="text-[12.5px] text-foreground/65">
                  {t("when.manual")}
                </p>
              )}
            </div>
          )}
        </SectionCard>
      );
    case "steps":
      return (
        <SectionCard
          title={resolveObjectNounPlural("stage")}
          count={read.steps.length}
        >
          {rows(
            read.steps.map((step, i) => {
              const uses = stepUses(step);
              const gate = stepGateLabel(step);
              const secondary = [
                // Who works it, as a label on its own (the desktop's legend
                // word), never cased into a sentence.
                runnerLabel(step, locale),
                uses ? `${t("steps.uses")}: ${uses}` : null,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <ResourceRow
                  key={step.key}
                  Icon={ListChecks}
                  primary={`${i + 1}. ${step.name}`}
                  secondary={secondary}
                  status={gate ? { kind: "unknown", label: gate } : undefined}
                  wrap
                />
              );
            })
          )}
        </SectionCard>
      );
    case "checks":
      return (
        <SectionCard
          title={t("block.checks")}
          count={read.checks.criteria.length}
        >
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] text-foreground/85">
            {read.checks.criteria.map((c) => {
              const step = c.stepKey
                ? read.steps.find((s) => s.key === c.stepKey)?.name
                : null;
              return (
                <li key={c.key}>
                  {step
                    ? t("checks.ofStep", { statement: c.statement, step })
                    : c.statement}
                </li>
              );
            })}
          </ul>
        </SectionCard>
      );
    case "moves": {
      if (failed || !read.moves) {
        return <SectionCard title={t("block.moves")}>{explain}</SectionCard>;
      }
      const moves = read.moves;
      return (
        <SectionCard
          title={t("block.moves")}
          hint={resolveObjectNounPlural(moves.profileSlug)}
        >
          <ol className="flex flex-wrap gap-2">
            {moves.states.map((s, i) => (
              <li
                key={s.key}
                className="inline-flex items-center gap-1.5 rounded-md bg-foreground/[0.04] px-2.5 py-1 text-[12.5px] text-foreground ring-1 ring-inset ring-foreground/10"
              >
                <span className="tabular text-foreground/65">{i + 1}</span>
                {s.label}
              </li>
            ))}
          </ol>
          {moves.undeclaredStatuses.length > 0 && (
            <p className="mt-2 text-[12.5px] text-foreground/65">
              {t("moves.undeclared", {
                statuses: moves.undeclaredStatuses
                  .map((x) => humanizeToken(x))
                  .join(", "),
              })}
            </p>
          )}
        </SectionCard>
      );
    }
    case "needs":
      // Read-only until lane L3's need-binding door reaches this PR's base
      // (plan W3, branch feat/process-needs): the select will read
      // `needs.forWorkspace({ workspaceId })` candidates and write
      // `needs.bind({ workspaceId, need, providerCapabilityId })`, which may
      // answer "proposed" (checkPermissionOrPropose).
      // TODO(process-wave L3): wire the provider select to those doors.
      return (
        <SectionCard
          title={t("block.needs")}
          count={failed ? null : read.needs.length}
          hint={failed ? undefined : t("needs.readOnly")}
        >
          {failed ? (
            explain
          ) : (
            <div className="flex flex-col gap-2">
              {rows(
                read.needs.map((need) => {
                  const row = needRow(need);
                  return (
                    <div
                      key={`${need.source}:${need.slug}`}
                      className="flex min-h-12 items-center justify-between gap-3 px-3 py-2"
                    >
                      <span className="min-w-0 truncate text-[13px] font-medium text-foreground">
                        {row.label}
                      </span>
                      {row.state === "filled" ? (
                        <span className="text-[13px] text-foreground/85">
                          {row.provider}
                        </span>
                      ) : row.state === "empty" ? (
                        <StatusPill kind="stale" label={t("needs.choose")} />
                      ) : (
                        <StatusPill kind="unknown" label={t("needs.unknown")} />
                      )}
                    </div>
                  );
                })
              )}
              <p className="text-[12px] text-foreground/65">
                {t("needs.shared")}
              </p>
            </div>
          )}
        </SectionCard>
      );
    case "skills":
      return (
        <SectionCard
          title={t("block.skills")}
          count={failed ? null : read.skills.length}
        >
          {failed ? (
            explain
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {read.skills.map((s) =>
                s.id ? (
                  <Link
                    key={`${s.source}:${s.id}`}
                    href={`/open/skill/${encodeURIComponent(s.id)}`}
                    className="rounded bg-foreground/[0.06] px-2 py-1 text-[12px] text-foreground hover:bg-foreground/[0.1]"
                  >
                    {s.name}
                  </Link>
                ) : (
                  <span
                    key={`${s.source}:${s.slug ?? s.name}`}
                    className="rounded bg-foreground/[0.04] px-2 py-1 text-[12px] text-foreground/65"
                  >
                    {s.name}
                  </span>
                )
              )}
            </div>
          )}
        </SectionCard>
      );
    case "runs":
      // D4: runs are counts in the facts, doors to the desktop.
      return null;
  }
}

/** One automation of the process: a door to its page, its on/off state. */
function AutomationRow({
  automation,
}: {
  automation: ProcessRead["when"]["automations"][number];
}) {
  const pill = statusPillFor(automation.status);
  return (
    <div className="flex min-h-12 items-center justify-between gap-3 px-3 py-2">
      <Link
        href={`${navHref("rules")}/${encodeURIComponent(automation.id)}`}
        className="flex min-w-0 items-center gap-2 text-[13px] text-foreground hover:underline"
      >
        <Zap className="h-4 w-4 shrink-0 text-foreground/40" aria-hidden />
        <span className="truncate">{automation.name}</span>
      </Link>
      {pill && <StatusPill kind={pill.kind} label={pill.label} />}
    </div>
  );
}

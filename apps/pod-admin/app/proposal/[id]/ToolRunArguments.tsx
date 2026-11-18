"use client";

/**
 * What a tool run SENDS: every argument the agent passed, labelled in the
 * verb's own words, each value whole. The page's heading already names the
 * call ("Create server · Hetzner cloud", `proposalHeading`); this replaces the
 * generic record card, which read a run as "Untitled · Tool" with its
 * arguments' NAMES only. The reading rules live in `tool-run-model.ts`.
 *
 * Declutter (founder, 17 Nov 2026): the card shows what the tool DOES: the
 * text as it will be sent, the account, and one line of consequence. The
 * tool's description, ids, the policy mark and the rest sit behind "Details"
 * (`children`). A text argument can be changed in place; the change is sent
 * with "Approve with your changes" (`DecisionButtons`) and recorded on the
 * proposal's revision chain, shown here as "Proposed as" to every reader.
 */

import { useState, type ReactNode } from "react";
import { Button, Chip } from "@heroui/react";
import { Lock, Pencil } from "lucide-react";
import type { ProposalToolRun } from "@synap-core/types/proposals/capability-run";
import { CodeValue, RECORD_GRID_CLASS } from "./ProposedRecordCard";
import { proposalPageT } from "./copy";
import {
  toolRunSplit,
  type ToolRunArgument,
  type ToolRunValue,
} from "./tool-run-model";
import type { ToolRunEdit } from "@synap-core/types/proposals/capability-run";

type T = ReturnType<typeof proposalPageT>;

function Value({ value, t }: { value: ToolRunValue; t: T }) {
  switch (value.kind) {
    case "text":
      return (
        <span className="whitespace-pre-wrap break-words">{value.text}</span>
      );
    case "link":
      return (
        <a
          href={value.href}
          target="_blank"
          rel="noreferrer noopener"
          className="rq-ink break-all underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground/70"
        >
          {value.text}
        </a>
      );
    case "code":
      return <CodeValue text={value.text} lines={value.lines} />;
    case "list":
      return (
        <span className="flex flex-wrap gap-1">
          {value.items.map((item, i) => (
            <Chip key={`${i}:${item}`} size="sm" variant="flat" radius="sm">
              {item}
            </Chip>
          ))}
        </span>
      );
    case "yes":
      return <span>{t("toolRun.yes")}</span>;
    case "no":
      return <span>{t("toolRun.no")}</span>;
    case "empty":
      return <em className="text-foreground/50">{t("toolRun.empty")}</em>;
    case "secret":
      return (
        <span className="inline-flex items-center gap-1 text-foreground/70">
          <Lock aria-hidden className="h-3.5 w-3.5" />
          {t("toolRun.secret")}
        </span>
      );
  }
}

function Argument({
  arg,
  t,
  edit,
}: {
  arg: ToolRunArgument;
  t: T;
  edit?: {
    draft: string | undefined;
    recorded: ToolRunEdit | undefined;
    onDraft: ((text: string | undefined) => void) | null;
  };
}) {
  const [editing, setEditing] = useState(false);
  const canEdit = !!edit?.onDraft && arg.editable;
  const edited = edit?.draft !== undefined && edit.draft !== arg.raw;
  return (
    <div
      data-tool-run-arg={arg.key}
      className={`flex min-w-0 flex-col gap-1 ${arg.wide || editing ? "col-span-full" : ""}`}
    >
      <dt className="flex items-center gap-2 text-[12.5px] font-medium text-foreground/70">
        {arg.label}
        {canEdit && !editing && (
          <Button
            size="sm"
            variant="light"
            className="min-h-8"
            startContent={<Pencil aria-hidden className="h-3.5 w-3.5" />}
            onPress={() => setEditing(true)}
          >
            {t("toolRun.edit")}
          </Button>
        )}
      </dt>
      <dd className="flex min-w-0 flex-col gap-1 text-[13px] leading-relaxed text-foreground/90">
        {editing && canEdit ? (
          <>
            <textarea
              aria-label={arg.label}
              data-tool-run-edit={arg.key}
              className="min-h-28 w-full rounded-md bg-background px-3 py-2 text-[13px] leading-relaxed text-foreground ring-1 ring-inset ring-foreground/20 focus:outline-none focus:ring-2 focus:ring-foreground/50"
              value={edit?.draft ?? arg.raw ?? ""}
              onChange={(e) => edit?.onDraft?.(e.target.value)}
            />
            <span className="flex gap-2">
              <Button
                size="sm"
                variant="flat"
                className="min-h-9"
                onPress={() => {
                  edit?.onDraft?.(undefined);
                  setEditing(false);
                }}
              >
                {t("toolRun.undoEdit")}
              </Button>
            </span>
          </>
        ) : (
          <Value
            value={
              edited ? { kind: "text", text: edit?.draft ?? "" } : arg.value
            }
            t={t}
          />
        )}
        {edited && !editing && (
          <span className="text-[12px] text-foreground/70">
            {t("toolRun.yourChange")}
          </span>
        )}
        {edit?.recorded && (
          <span
            data-tool-run-was={arg.key}
            className="flex flex-col gap-0.5 text-[12px] text-foreground/70"
          >
            <span className="font-medium">{t("toolRun.proposedAs")}</span>
            <span className="whitespace-pre-wrap break-words line-through decoration-foreground/30">
              {edit.recorded.before}
            </span>
          </span>
        )}
        {arg.description && arg.detail && (
          <span className="text-[12px] text-foreground/70">
            {arg.description}
          </span>
        )}
      </dd>
    </div>
  );
}

export function ToolRunArguments({
  run,
  drafts,
  onDraft,
  recorded = [],
  children,
}: {
  run: ProposalToolRun;
  /** The changes made on this page, not yet sent (argument key -> text). */
  drafts: Readonly<Record<string, string>>;
  /** Absent when the request can no longer be decided: the text is read-only. */
  onDraft: ((key: string, text: string | undefined) => void) | null;
  /** What people already changed, from the revision chain. */
  recorded?: readonly ToolRunEdit[];
  /** The rest, behind "Details" (the policy mark, the reason). */
  children?: ReactNode;
}) {
  const t = proposalPageT();
  const { shown, detail } = toolRunSplit(run);
  const wasByKey = new Map(recorded.map((e) => [e.key, e]));
  const editFor = (arg: ToolRunArgument) => ({
    draft: drafts[arg.key],
    recorded: wasByKey.get(arg.key),
    onDraft: onDraft
      ? (text: string | undefined) => onDraft(arg.key, text)
      : null,
  });
  const account = run.parameters.find(
    (p) =>
      /account/i.test(p.key) &&
      typeof p.value === "string" &&
      !p.secret &&
      /\s|@/.test(p.value)
  );
  const consequence = [
    run.action,
    run.tool ? t("toolRun.through", { tool: run.tool }) : null,
    account ? t("toolRun.as", { account: String(account.value) }) : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <section
      aria-label={t("toolRun.sends")}
      data-tool-run=""
      className="flex flex-col gap-3 rounded-lg bg-foreground/[0.03] px-4 py-3.5 ring-1 ring-inset ring-foreground/10"
    >
      <header className="flex flex-col gap-0.5">
        <h2 className="font-heading text-[15px] font-medium text-foreground">
          {t("toolRun.sends")}
        </h2>
        <p
          data-tool-run-consequence=""
          className="text-[12.5px] text-foreground/65"
        >
          {consequence}
        </p>
      </header>
      {shown.length > 0 ? (
        <dl className={RECORD_GRID_CLASS}>
          {shown.map((arg) => (
            <Argument key={arg.key} arg={arg} t={t} edit={editFor(arg)} />
          ))}
        </dl>
      ) : (
        <p className="text-[13px] text-foreground/70">
          {t("toolRun.noArguments")}
        </p>
      )}
      <details data-tool-run-details="" className="group text-[12.5px]">
        <summary className="min-h-9 cursor-pointer select-none py-1.5 font-medium text-foreground/70">
          {t("toolRun.details")}
        </summary>
        <div className="flex flex-col gap-3 pt-2">
          {run.description && (
            <p className="text-foreground/65">{run.description}</p>
          )}
          {detail.length > 0 && (
            <dl className={RECORD_GRID_CLASS}>
              {detail.map((arg) => (
                <Argument key={arg.key} arg={arg} t={t} edit={editFor(arg)} />
              ))}
            </dl>
          )}
          {children}
        </div>
      </details>
    </section>
  );
}

"use client";

/**
 * What a tool run SENDS: every argument the agent passed, labelled in the
 * verb's own words, each value whole. The page's heading already names the
 * call ("Create server · Hetzner cloud", `proposalHeading`); this replaces the
 * generic record card, which read a run as "Untitled · Tool" with its
 * arguments' NAMES only. The reading rules live in `tool-run-model.ts`.
 */

import { Chip } from "@heroui/react";
import { Lock } from "lucide-react";
import type { ProposalToolRun } from "@synap-core/types/proposals/capability-run";
import { CodeValue, RECORD_GRID_CLASS } from "./ProposedRecordCard";
import { proposalPageT } from "./copy";
import {
  toolRunArguments,
  type ToolRunArgument,
  type ToolRunValue,
} from "./tool-run-model";

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
          className="break-all text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary"
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
        <span className="inline-flex items-center gap-1 text-foreground/60">
          <Lock aria-hidden className="h-3.5 w-3.5" />
          {t("toolRun.secret")}
        </span>
      );
  }
}

function Argument({ arg, t }: { arg: ToolRunArgument; t: T }) {
  return (
    <div
      data-tool-run-arg={arg.key}
      className={`flex min-w-0 flex-col gap-1 ${arg.wide ? "col-span-full" : ""}`}
    >
      <dt className="text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/60">
        {arg.label}
      </dt>
      <dd className="flex min-w-0 flex-col gap-1 text-[13px] leading-relaxed text-foreground/90">
        <Value value={arg.value} t={t} />
        {arg.description && (
          <span className="text-[12px] text-foreground/55">
            {arg.description}
          </span>
        )}
      </dd>
    </div>
  );
}

export function ToolRunArguments({ run }: { run: ProposalToolRun }) {
  const t = proposalPageT();
  const args = toolRunArguments(run);
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
        {run.description && (
          <p className="text-[12.5px] text-foreground/65">{run.description}</p>
        )}
      </header>
      {args.length > 0 ? (
        <dl className={RECORD_GRID_CLASS}>
          {args.map((arg) => (
            <Argument key={arg.key} arg={arg} t={t} />
          ))}
        </dl>
      ) : (
        <p className="text-[13px] text-foreground/70">
          {t("toolRun.noArguments")}
        </p>
      )}
    </section>
  );
}

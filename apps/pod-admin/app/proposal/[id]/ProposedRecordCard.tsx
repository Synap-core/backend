"use client";

/**
 * The record approving creates, changes or removes — drawn the way an object
 * reads elsewhere in the console: its name as the heading, its kind as a quiet
 * mark beside it, its fields in a grid that uses the width (as many columns as
 * fit, one on a phone), each value in the reading its type gives it. The rules
 * live in `proposal-record-model.ts`; this only draws them.
 */

import { useState, type ReactNode } from "react";
import { Button, Chip } from "@heroui/react";
import { ArrowRight } from "lucide-react";
import { kindIcon, kindLabel } from "../../_lib/object/kind-icon";
import { Pill } from "../../_lib/object/provenance-chips";
import { StatusPill } from "../../(admin)/components/status-pill";
import { statusPillFor } from "../../(admin)/components/status-tone";
import { openIn } from "../../../lib/open-in";
import type { MediaRef } from "@synap-core/types/presentation";
import { MediaView } from "../../_lib/media/media-view";
import { TextDiff } from "../../_lib/object/content/document-changes";
import { resolveObjectNounPlural } from "@synap-core/types/vocabulary";
import type { PartEdge } from "./composite-parts-model";
import type { RecordGroup } from "./record-groups";
import {
  RECORD_FIELDS_SHOWN,
  type ProposedRecord,
  type RecordField,
  type RecordValue,
} from "./proposal-record-model";

/**
 * As many columns as fit, never narrower than 13rem: one in a phone or a
 * narrow drawer, two or three on a wide page. The container's width decides,
 * not the viewport's, so the same card reads right in the drawer and the page.
 */
export const RECORD_GRID_CLASS =
  "grid grid-cols-[repeat(auto-fill,minmax(min(100%,13rem),1fr))] gap-x-6 gap-y-3";

/** Lines of code shown before "Show all N lines": folded, never cut. */
export const CODE_LINES_SHOWN = 40;

export function CodeValue({ text, lines }: { text: string; lines: number }) {
  const [all, setAll] = useState(false);
  const folded = !all && lines > CODE_LINES_SHOWN;
  return (
    <span className="flex w-full min-w-0 flex-col gap-1">
      <pre
        data-record-code=""
        className="max-w-full overflow-x-auto whitespace-pre rounded-md bg-foreground/[0.04] px-3 py-2 font-mono text-[12px] leading-relaxed text-foreground/90 ring-1 ring-inset ring-foreground/10"
      >
        <code>
          {folded
            ? text.split("\n").slice(0, CODE_LINES_SHOWN).join("\n")
            : text}
        </code>
      </pre>
      {folded && (
        <Button
          size="sm"
          variant="light"
          className="self-start px-1 text-[12.5px] text-foreground/65"
          onPress={() => setAll(true)}
        >
          Show all {lines} lines
        </Button>
      )}
    </span>
  );
}

function Value({ value }: { value: RecordValue }) {
  switch (value.kind) {
    case "code":
      return <CodeValue text={value.text} lines={value.lines} />;
    case "text":
      return (
        <span
          className={
            value.long
              ? "line-clamp-4 whitespace-pre-line break-words"
              : "break-words"
          }
          title={value.long ? value.text : undefined}
        >
          {value.text}
        </span>
      );
    case "status": {
      const pill = statusPillFor(value.raw);
      return pill ? (
        <StatusPill kind={pill.kind} label={value.label} />
      ) : (
        <span>{value.label}</span>
      );
    }
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
    case "ref": {
      const Icon = kindIcon(value.objectKind);
      return (
        <Pill
          exit={openIn({
            kind: "object",
            objectKind: value.objectKind,
            id: value.id,
          })}
          title={kindLabel(value.objectKind)}
        >
          <Icon aria-hidden className="h-3.5 w-3.5 text-foreground/55" />
          <span className="truncate">{value.name}</span>
        </Pill>
      );
    }
    case "changes":
      return (
        <span className="flex w-full min-w-0 flex-col">
          <TextDiff change={value.change} code={value.code} />
        </span>
      );
    case "tags":
      return (
        <span className="flex flex-wrap gap-1">
          {value.items.map((item) => (
            <Chip key={item} size="sm" variant="flat" radius="sm">
              {item}
            </Chip>
          ))}
        </span>
      );
  }
}

/** One side of a code change, named: struck-through code would be unreadable. */
function CodeSide({ label, value }: { label: string; value: RecordValue }) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-1">
      <span className="text-[11px] text-foreground/55">{label}</span>
      <Value value={value} />
    </div>
  );
}

function Field({ field }: { field: RecordField }) {
  const { before, after, op } = field;
  const label = (
    <dt className="text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/60">
      {field.label}
    </dt>
  );
  if (op === "change" && before?.kind === "code" && after) {
    return (
      <div
        data-record-field={field.key}
        className="col-span-full flex min-w-0 flex-col gap-1"
      >
        {label}
        <dd className="flex min-w-0 flex-col gap-2 text-[13px] leading-relaxed text-foreground/90">
          <CodeSide label="Before" value={before} />
          <CodeSide label="After" value={after} />
        </dd>
      </div>
    );
  }
  return (
    <div
      data-record-field={field.key}
      className={`flex min-w-0 flex-col gap-1 ${field.wide ? "col-span-full" : ""}`}
    >
      {label}
      <dd className="flex min-w-0 flex-wrap items-center gap-1.5 text-[13px] leading-relaxed text-foreground/90">
        {op !== "add" && before !== undefined && (
          <span className="text-foreground/50 line-through decoration-foreground/30">
            {before ? <Value value={before} /> : <em>empty</em>}
          </span>
        )}
        {op === "change" && before !== undefined && (
          <ArrowRight
            aria-label="becomes"
            className="h-3.5 w-3.5 shrink-0 text-foreground/40"
          />
        )}
        {op !== "remove" &&
          (after ? (
            <Value value={after} />
          ) : (
            <em className="text-foreground/50">empty</em>
          ))}
        {op === "remove" && (
          <span className="text-[12px] text-status-down">removed</span>
        )}
      </dd>
      {field.stale && (
        <span className="text-[11.5px] text-warning">
          Edited since this was proposed — the value before is out of date.
        </span>
      )}
    </div>
  );
}

export function ProposedRecordCard({
  record,
  media,
  mediaAlt,
  children,
}: {
  record: ProposedRecord;
  /** The record's image (an upload waiting for approval), drawn as a thumbnail. */
  media?: MediaRef | null;
  /** The image's name for someone who cannot see it (`mediaAlt`). */
  mediaAlt?: string;
  /** What sits under the fields: this record's twins and its choice. */
  children?: ReactNode;
}) {
  const [all, setAll] = useState(false);
  const fields = all
    ? record.fields
    : record.fields.slice(0, RECORD_FIELDS_SHOWN);
  const hidden = record.fields.length - fields.length;
  const KindIcon = record.kind ? kindIcon(record.kind) : null;
  const title = record.title ?? "Untitled";

  return (
    <section
      aria-label={title}
      data-proposed-record={record.ref}
      className="flex flex-col gap-3 rounded-lg bg-foreground/[0.03] px-4 py-3.5 ring-1 ring-inset ring-foreground/10"
    >
      <header className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h2
          className={`min-w-0 break-words font-heading text-[17px] font-medium leading-snug text-foreground ${
            record.op === "delete"
              ? "line-through decoration-foreground/40"
              : ""
          }`}
        >
          {title}
        </h2>
        {record.kind && KindIcon && (
          <span
            data-record-kind=""
            className="inline-flex items-center gap-1 text-[12px] text-foreground/55"
          >
            <KindIcon aria-hidden className="h-3.5 w-3.5" />
            {kindLabel(record.kind)}
          </span>
        )}
      </header>
      {media && (
        <MediaView
          media={media}
          alt={mediaAlt ?? record.title ?? ""}
          size="thumb"
        />
      )}
      {fields.length > 0 && (
        <dl className={RECORD_GRID_CLASS}>
          {fields.map((field) => (
            <Field key={field.key} field={field} />
          ))}
        </dl>
      )}
      {hidden > 0 && (
        <Button
          size="sm"
          variant="light"
          className="self-start px-1 text-[12.5px] text-foreground/65"
          onPress={() => setAll(true)}
        >
          Show all {record.fields.length} fields
        </Button>
      )}
      {children}
    </section>
  );
}

/**
 * One kind's records, capped (`record-groups.ts`), then "Show all N <kind>".
 * `render` draws one record (its card, its twins and its choice).
 */
export function RecordGroupList<T extends ProposedRecord>({
  group,
  render,
}: {
  group: RecordGroup<T>;
  render: (record: T) => ReactNode;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? group.all : group.shown;
  const noun = resolveObjectNounPlural(group.kind ?? "entity");
  return (
    <>
      {shown.map(render)}
      {group.all.length > shown.length && (
        <Button
          size="sm"
          variant="light"
          className="self-start px-1 text-[12.5px] text-foreground/65"
          onPress={() => setAll(true)}
        >
          Show all {group.all.length} {noun.toLowerCase()}
        </Button>
      )}
    </>
  );
}

/** Links shown before "Show all N links". */
export const EDGES_SHOWN = 8;

/**
 * The links a graph proposal makes between its parts (relations, a plan's
 * session links), one line each: "Léa · Works at · Acme". Capped, then
 * "Show all N".
 */
export function PartEdgeList({ edges }: { edges: readonly PartEdge[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? edges : edges.slice(0, EDGES_SHOWN);
  const noun = resolveObjectNounPlural("relation");
  return (
    <section
      aria-label={noun}
      data-part-edges=""
      className="flex flex-col gap-2 rounded-lg bg-foreground/[0.03] px-4 py-3.5 ring-1 ring-inset ring-foreground/10"
    >
      <h2 className="font-heading text-[15px] font-medium text-foreground">
        {noun}
      </h2>
      <ul className="flex flex-col gap-1">
        {shown.map((edge) => (
          <li
            key={edge.ref}
            className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[13px] text-foreground/85"
          >
            <span className="break-words">{edge.from}</span>
            <span className="text-[12px] text-foreground/55">{edge.verb}</span>
            <span className="break-words">{edge.to}</span>
          </li>
        ))}
      </ul>
      {edges.length > shown.length && (
        <Button
          size="sm"
          variant="light"
          className="self-start px-1 text-[12.5px] text-foreground/65"
          onPress={() => setAll(true)}
        >
          Show all {edges.length} {noun.toLowerCase()}
        </Button>
      )}
    </section>
  );
}

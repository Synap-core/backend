"use client";

/**
 * The three lines of an app's access (design A): "It can", "In" and "It
 * changes things in", each its current answer and ONE door. The consent,
 * the re-consent and the app page draw them; only the sheet's footer differs:
 *
 *  - `consent`: every choice edits the draft at once (the headline above
 *    follows it, and is announced inside the open sheet too), and the sheet
 *    closes with Done;
 *  - `page`: the sheet edits a copy; Cancel drops it, Save hands it to the
 *    page. Closing it with unsaved edits asks first. A space or project
 *    named on the page is a door to it (ui-composition §3); on the consent
 *    names stay text, since leaving would abandon the authorization.
 *
 * Every place is named through ONE builder (`readParts` / `writeParts`):
 * never a bare id. "It changes things in" is OMITTED while nothing is at
 * Edit or On.
 */

import { Fragment, useState, type ReactNode } from "react";
import Link from "next/link";
import { Button } from "@heroui/react";
import {
  andList,
  canSummary,
  decisionsOff,
  needsWritePlace,
  notEverywhere,
  readParts,
  sameDraft,
  writeParts,
  type CanRow,
  type ConsentDraft,
  type ConsentOffer,
  partWords,
  toAccess,
  type PlacePart,
} from "./consent-access";
import type { ActsAs } from "./consent-model";
import { CanChoices, InChoices, WriteChoices } from "./AccessChoices";
import { ConsentLine, ConsentLines, type LineMark } from "./ConsentLine";
import { consentT } from "./copy";

type Line = "can" | "in" | "write";

/** "A", "A and B", "A, B and C", over nodes (a name may be a door). */
function joinNodes(nodes: readonly ReactNode[], last: string): ReactNode {
  return nodes.map((n, i) => (
    <Fragment key={i}>
      {i === 0 ? null : i === nodes.length - 1 ? last : ", "}
      {n}
    </Fragment>
  ));
}

/** A place's name, and on the app page a door to it. */
function PlaceName({ part, door }: { part: PlacePart; door: boolean }) {
  const name = partWords(part);
  if (!door || part.gone) return <>{name}</>;
  return (
    <Link
      href={`/open/${part.kind}/${encodeURIComponent(part.id)}`}
      className="underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground"
    >
      {name}
    </Link>
  );
}

export interface AccessLinesProps {
  mode: "consent" | "page";
  appName: string;
  /** The app declared workspace templates (`synap_templates`). */
  declaredPlaces: boolean;
  draft: ConsentDraft;
  offer: ConsentOffer;
  rows: readonly CanRow[];
  actsAs: ActsAs;
  podWideKinds: readonly string[];
  names: Readonly<Record<string, string>>;
  /** The live access sentence, announced inside an open sheet. */
  live?: string;
  /** The consent: each choice, at once. */
  onChange?: (next: ConsentDraft) => void;
  /** The page: a sheet's Save. */
  onSave?: (next: ConsentDraft) => void;
  marks?: Partial<Record<Line, LineMark | null>>;
  isDisabled?: boolean;
  /** Which sheet starts open (a test, a screenshot). */
  defaultOpen?: Line | null;
  /**
   * The lines only say their answers: no door (an action that cannot apply
   * is absent, never disabled).
   */
  readOnly?: boolean;
}

export function AccessLines(props: AccessLinesProps) {
  const t = consentT();
  const { draft, mode } = props;
  const [open, setOpen] = useState<Line | null>(props.defaultOpen ?? null);
  // The app page edits a copy until Save; closing it dirty asks first.
  const [editing, setEditing] = useState<ConsentDraft>(draft);
  const [discarding, setDiscarding] = useState(false);
  const shown = mode === "page" && open ? editing : draft;
  const dirty = mode === "page" && open !== null && !sameDraft(editing, draft);
  const edit = (next: ConsentDraft) =>
    mode === "page" ? setEditing(next) : props.onChange?.(next);
  const openLine = (line: Line, isOpen: boolean) => {
    if (isOpen) {
      setEditing(draft);
      setDiscarding(false);
      setOpen(line);
      return;
    }
    if (dirty) {
      setDiscarding(true);
      return;
    }
    setOpen(null);
  };
  const close = () => {
    setDiscarding(false);
    setOpen(null);
  };
  const door = mode === "page";

  const footer =
    mode === "page" ? (
      discarding ? (
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <span role="alert" className="mr-auto text-xs text-foreground/80">
            {t("page.unsaved")}
          </span>
          <Button
            size="sm"
            variant="light"
            className="min-h-10"
            onPress={() => setDiscarding(false)}
          >
            {t("page.keepEditing")}
          </Button>
          <Button
            size="sm"
            color="danger"
            variant="flat"
            className="min-h-10"
            onPress={close}
          >
            {t("page.discard")}
          </Button>
        </div>
      ) : (
        <>
          <Button
            size="sm"
            variant="light"
            className="min-h-10"
            onPress={close}
          >
            {t("sheet.cancel")}
          </Button>
          <Button
            size="sm"
            color="primary"
            className="min-h-10"
            isDisabled={!dirty}
            onPress={() => {
              props.onSave?.(editing);
              close();
            }}
          >
            {t("sheet.save")}
          </Button>
        </>
      )
    ) : (
      <Button size="sm" color="primary" className="min-h-10" onPress={close}>
        {t("sheet.done")}
      </Button>
    );
  const sheet = (
    line: Line,
    doorLabel: string,
    title: string,
    children: ReactNode
  ) =>
    props.readOnly
      ? null
      : {
          doorLabel,
          doorAccessibleName: `${doorLabel}: ${title}`,
          title,
          isOpen: open === line,
          onOpenChange: (o: boolean) => openLine(line, o),
          isDisabled: props.isDisabled,
          footer,
          live: props.live,
          children,
        };

  // It can: one entry per level given; what holds only in picked spaces
  // under All, and the decisions left off, are said beside it.
  // Counted from what it will actually reach under the current "In" (the
  // access Allow sends), the same set the headline counts.
  const reached = new Set(toAccess(draft, props.offer).permissions);
  const can = canSummary({ ...draft, permissions: reached }, props.rows);
  const levelWord = {
    view: t("level.view"),
    edit: t("level.edit"),
    on: t("level.on"),
  };
  const onlyPicked = notEverywhere(draft, props.rows, props.offer);
  const notDecide = decisionsOff(draft, props.rows);

  // In: every place, or the picked spaces "or" projects.
  const read = readParts(draft, props.names);
  const and = t("list.and");
  const inAnswer: ReactNode =
    read === "all"
      ? t("in.every")
      : (() => {
          const groups: ReactNode[] = [];
          if (read.spaces.length > 0)
            groups.push(
              joinNodes(
                read.spaces.map((p) => (
                  <PlaceName key={p.id} part={p} door={door} />
                )),
                and
              )
            );
          if (read.projects === "all") groups.push(t("in.everyProject"));
          else if (read.projects.length > 0)
            groups.push(
              joinNodes(
                read.projects.map((p) => (
                  <PlaceName key={p.id} part={p} door={door} />
                )),
                and
              )
            );
          return groups.length === 0
            ? t("in.nowhere")
            : joinNodes(groups, t("list.or"));
        })();

  // It changes things in.
  const writes = writeParts(draft, props.names).map((p) => (
    <PlaceName key={p.id} part={p} door={door} />
  ));
  const writeLine = needsWritePlace(draft);

  return (
    <ConsentLines>
      <ConsentLine
        line="can"
        label={t("line.can")}
        mark={props.marks?.can}
        sheet={sheet(
          "can",
          mode === "page" ? t("door.change") : t("door.review"),
          t("sheet.can"),
          <CanChoices
            rows={props.rows}
            draft={shown}
            actsAs={props.actsAs}
            appName={props.appName}
            podWideKinds={props.podWideKinds}
            isDisabled={props.isDisabled}
            onChange={edit}
          />
        )}
      >
        {can.length === 0 ? (
          <span className="text-foreground/65">{t("can.nothing")}</span>
        ) : (
          can.map((c) => (
            <span key={c.level}>
              <span className="text-foreground/65">{levelWord[c.level]}</span>{" "}
              {c.text}
            </span>
          ))
        )}
        {notDecide.map((what) => (
          <span key={what} className="text-xs text-foreground/65">
            {t("can.notDecide", { what })}
          </span>
        ))}
        {onlyPicked.length > 0 ? (
          <span className="text-xs text-foreground/65">
            {t("can.onlyPicked", { names: andList(onlyPicked) })}
          </span>
        ) : null}
      </ConsentLine>
      <ConsentLine
        line="in"
        label={t("line.in")}
        mark={props.marks?.in}
        sheet={sheet(
          "in",
          t("door.change"),
          t("sheet.in"),
          <InChoices
            draft={shown}
            offer={props.offer}
            rows={props.rows}
            isDisabled={props.isDisabled}
            onChange={edit}
          />
        )}
      >
        <span>{inAnswer}</span>
      </ConsentLine>
      {writeLine ? (
        <ConsentLine
          line="write"
          label={t("line.write")}
          mark={props.marks?.write}
          needsYou={writes.length === 0}
          sheet={sheet(
            "write",
            writes.length === 0 ? t("door.pick") : t("door.change"),
            t("sheet.write"),
            <WriteChoices
              draft={shown}
              offer={props.offer}
              isDisabled={props.isDisabled}
              onChange={edit}
            />
          )}
        >
          {writes.length > 0 ? (
            <span>{joinNodes(writes, and)}</span>
          ) : (
            <>
              <strong className="font-medium">{t("write.pickWhere")}</strong>
              {props.declaredPlaces ? null : (
                <span className="text-xs text-foreground/65">
                  {t("write.undeclared", { name: props.appName })}
                </span>
              )}
            </>
          )}
        </ConsentLine>
      ) : null}
    </ConsentLines>
  );
}

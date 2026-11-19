"use client";

/**
 * The three lines of an app's access (design A): "It can", "In" and "It
 * changes things in", each its current answer and ONE door. The consent,
 * the re-consent and the app page draw them; only the sheet's footer differs:
 *
 *  - `consent`: every choice edits the draft at once (the headline above
 *    follows it), and the sheet closes with Done;
 *  - `page`: the sheet edits a copy; Cancel drops it, Save hands it to the
 *    page (which saves it and shows a receipt with Undo). A space or project
 *    named on the page is a door to it (ui-composition §3); on the consent
 *    names stay text, since leaving would abandon the authorization.
 *
 * "It changes things in" is OMITTED while nothing is at Edit or On.
 */

import { Fragment, useState, type ReactNode } from "react";
import Link from "next/link";
import { Button } from "@heroui/react";
import {
  canSummary,
  needsWritePlace,
  sameDraft,
  type CanRow,
  type ConsentDraft,
  type ConsentOffer,
} from "./consent-access";
import type { ActsAs } from "./consent-model";
import { CanChoices, InChoices, WriteChoices } from "./AccessChoices";
import { ConsentLine, ConsentLines, type LineMark } from "./ConsentLine";
import { consentT } from "./copy";

type Line = "can" | "in" | "write";

/** "A", "A and B", "A, B and C", over nodes (a name may be a door). */
function joinNodes(nodes: readonly ReactNode[], last = " and "): ReactNode {
  return nodes.map((n, i) => (
    <Fragment key={i}>
      {i === 0 ? null : i === nodes.length - 1 ? last : ", "}
      {n}
    </Fragment>
  ));
}

/** A place's name, and on the app page a door to it. */
function PlaceName({
  kind,
  id,
  name,
  door,
}: {
  kind: "workspace" | "project";
  id: string;
  name: string;
  door: boolean;
}) {
  if (!door) return <>{name}</>;
  return (
    <Link
      href={`/open/${kind}/${encodeURIComponent(id)}`}
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
  /** The consent: each choice, at once. */
  onChange?: (next: ConsentDraft) => void;
  /** The page: a sheet's Save. */
  onSave?: (next: ConsentDraft) => void;
  marks?: Partial<Record<Line, LineMark | null>>;
  isDisabled?: boolean;
  /** Which sheet starts open (a test, a screenshot). */
  defaultOpen?: Line | null;
}

export function AccessLines(props: AccessLinesProps) {
  const t = consentT();
  const { draft, mode } = props;
  const [open, setOpen] = useState<Line | null>(props.defaultOpen ?? null);
  // The app page edits a copy until Save.
  const [editing, setEditing] = useState<ConsentDraft>(draft);
  const shown = mode === "page" && open ? editing : draft;
  const edit = (next: ConsentDraft) =>
    mode === "page" ? setEditing(next) : props.onChange?.(next);
  const openLine = (line: Line, isOpen: boolean) => {
    if (isOpen) setEditing(draft);
    setOpen(isOpen ? line : null);
  };
  const door = mode === "page";

  const footer =
    mode === "page" ? (
      <>
        <Button
          size="sm"
          variant="light"
          className="min-h-10"
          onPress={() => setOpen(null)}
        >
          {t("sheet.cancel")}
        </Button>
        <Button
          size="sm"
          color="primary"
          className="min-h-10"
          isDisabled={sameDraft(editing, draft)}
          onPress={() => {
            props.onSave?.(editing);
            setOpen(null);
          }}
        >
          {t("sheet.save")}
        </Button>
      </>
    ) : (
      <Button
        size="sm"
        color="primary"
        className="min-h-10"
        onPress={() => setOpen(null)}
      >
        {t("sheet.done")}
      </Button>
    );
  const sheet = (
    line: Line,
    doorLabel: string,
    title: string,
    children: ReactNode
  ) => ({
    doorLabel,
    doorAccessibleName: `${doorLabel}: ${title}`,
    title,
    isOpen: open === line,
    onOpenChange: (o: boolean) => openLine(line, o),
    isDisabled: props.isDisabled,
    footer,
    children,
  });

  // It can: one entry per level given.
  const can = canSummary(draft, props.rows);
  const levelWord = {
    view: t("level.view"),
    edit: t("level.edit"),
    on: t("level.on"),
  };

  // In: every place, or the picked spaces "or" projects.
  const read = draft.read;
  const inAnswer: ReactNode =
    read.spaces === "all"
      ? t("in.every")
      : (() => {
          const spaces = read.spaces.map((id) => (
            <PlaceName
              key={id}
              kind="workspace"
              id={id}
              door={door}
              name={props.names[id] ?? id}
            />
          ));
          const projects =
            read.projects === "all"
              ? [<Fragment key="all">{t("in.allProjects")}</Fragment>]
              : read.projects.map((id) => (
                  <PlaceName
                    key={id}
                    kind="project"
                    id={id}
                    door={door}
                    name={props.names[id] ?? id}
                  />
                ));
          const parts = [spaces, projects]
            .filter((p) => p.length > 0)
            .map((p) => joinNodes(p));
          return parts.length === 0
            ? t("in.nowhere")
            : joinNodes(parts, ", or ");
        })();

  // It changes things in.
  const writes = [
    ...draft.write.spaces.map((id) => (
      <PlaceName
        key={id}
        kind="workspace"
        id={id}
        door={door}
        name={props.names[id] ?? id}
      />
    )),
    ...draft.write.projects.map((id) => (
      <PlaceName
        key={id}
        kind="project"
        id={id}
        door={door}
        name={props.names[id] ?? id}
      />
    )),
  ];
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
            <span>{joinNodes(writes)}</span>
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

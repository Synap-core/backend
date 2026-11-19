"use client";

/**
 * What each line's door opens (design A): the choices of "It can", "In"
 * and "It changes things in", as plain content. `AccessLines` hosts them in
 * a `ChoiceSheet`; a test renders them directly. Every change goes through
 * the pure rules of `consent-access`, so nothing here can widen the offer.
 */

import { useId, useState } from "react";
import { Checkbox, Chip, Radio, RadioGroup } from "@heroui/react";
import { Check, ChevronRight } from "lucide-react";
import {
  KINDS_ROW,
  andList,
  notEverywhere,
  readChoices,
  readProjectsMode,
  rowLevel,
  setReadProjectsMode,
  setReadSpacesMode,
  setRowLevel,
  showsUnion,
  toggleAllKinds,
  toggleKind,
  toggleReadProject,
  toggleReadSpace,
  toggleWritePlace,
  viewOnlySpaces,
  writeChoices,
  type CanRow,
  type ConsentDraft,
  type ConsentOffer,
} from "./consent-access";
import {
  ALSO_SEE,
  decideLine,
  levelControlLabel,
  permissionLabel,
  placeReachNote,
  podWideNote,
  readsSpaceRecords,
  type ActsAs,
  type ConsentObject,
} from "./consent-model";
import { CONSENT_CHECKBOX, LevelControl } from "./LevelControl";
import { KindsGroupRow } from "./KindsGroupRow";
import { consentT } from "./copy";

type OnChange = (next: ConsentDraft) => void;

const CAPTION = "text-pretty text-xs leading-relaxed text-foreground/65";

/** The developer's reasons and the raw permissions of a row, said once each. */
function RowDetail({ row }: { row: ConsentObject }) {
  const t = consentT();
  const reasons = [
    ...new Set(
      row.permissions
        .map((p) => p.reason?.trim())
        .filter((r): r is string => !!r)
    ),
  ];
  return (
    <>
      {reasons.map((r) => (
        <p key={r} className="text-pretty text-xs leading-relaxed text-foreground/75">
          {/* The developer's words, as text: why it asks. */}
          <span className="text-foreground/65">{t("reason.prefix")} </span>
          {r}
        </p>
      ))}
      <p className="break-words font-mono text-[11px] leading-relaxed text-foreground/65">
        {row.permissions.map((p) => p.permission).join(" · ")}
      </p>
    </>
  );
}

/** "Pillars, Journey stages, Series, Platforms +7 more": what it also sees. */
function alsoSeeNames(draft: ConsentDraft, row: ConsentObject): string {
  const given = row.members.filter((m) => rowLevel(draft, m) !== "off");
  const names = (given.length > 0 ? given : row.members).map((m) => m.label);
  return names.length <= 4
    ? names.join(", ")
    : `${names.slice(0, 4).join(", ")} +${names.length - 4} more`;
}

/** One object row of "It can": its name and words, its level, its detail. */
function CanObjectRow({
  row,
  draft,
  actsAs,
  podWideKind,
  isDisabled,
  onChange,
}: {
  row: ConsentObject;
  draft: ConsentDraft;
  actsAs: ActsAs;
  podWideKind: (row: ConsentObject) => boolean;
  isDisabled: boolean;
  onChange: OnChange;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const folded = row.key === ALSO_SEE;
  const words = folded
    ? alsoSeeNames(draft, row)
    : row.decisions
      ? decideLine(row, actsAs)
      : andList(row.permissions.map((p) => permissionLabel(p.permission)));
  return (
    <li className="flex flex-col py-1" data-object={row.key}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-detail`}
          onClick={() => setOpen((o) => !o)}
          className="-mx-1 flex min-h-10 min-w-0 flex-1 basis-40 items-center gap-1.5 rounded-md px-1 text-left hover:bg-foreground/[0.04] focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <ChevronRight
            aria-hidden
            className={`h-4 w-4 shrink-0 text-foreground/65 transition-transform ${open ? "rotate-90" : ""}`}
          />
          <span className="flex min-w-0 flex-col">
            <span className="text-sm font-medium text-foreground/90">
              {row.label}
            </span>
            <span className="text-xs text-foreground/65">{words}</span>
          </span>
        </button>
        <LevelControl
          label={levelControlLabel(row, actsAs)}
          levels={row.levels}
          level={rowLevel(draft, row)}
          isDisabled={isDisabled}
          onChange={(level) => onChange(setRowLevel(draft, row, level))}
        />
      </div>
      <div
        id={`${id}-detail`}
        hidden={!open}
        // A class's `display` beats the `hidden` attribute: keep both.
        className={`${open ? "flex" : "hidden"} flex-col gap-1.5 pb-2 pl-6 pt-1`}
      >
        {folded ? (
          <ul className="flex flex-col divide-y divide-foreground/10">
            {row.members.map((m) => (
              <CanObjectRow
                key={m.key}
                row={m}
                draft={draft}
                actsAs={actsAs}
                podWideKind={podWideKind}
                isDisabled={isDisabled}
                onChange={onChange}
              />
            ))}
          </ul>
        ) : (
          <>
            <RowDetail row={row} />
            {podWideKind(row) && draft.read.spaces !== "all" ? (
              <p className={CAPTION}>{podWideNote(row)}</p>
            ) : null}
          </>
        )}
      </div>
    </li>
  );
}

/** "It can": every row with its level; the F4 kinds as one row, first. */
export function CanChoices({
  rows,
  draft,
  actsAs,
  appName,
  podWideKinds,
  isDisabled = false,
  onChange,
}: {
  rows: readonly CanRow[];
  draft: ConsentDraft;
  actsAs: ActsAs;
  appName: string;
  /** The server's list of kinds kept pod-wide (`podWideKinds`), never a hand list. */
  podWideKinds: readonly string[];
  isDisabled?: boolean;
  onChange: OnChange;
}) {
  const t = consentT();
  const podWideKind = (row: ConsentObject) =>
    !!row.kind && podWideKinds.includes(row.kind);
  return (
    <div className="flex flex-col gap-1">
      <p className={CAPTION}>{t("sheet.canHint")}</p>
      <ul className="flex flex-col divide-y divide-foreground/10">
        {rows.map((row) =>
          row.key === KINDS_ROW ? (
            <KindsGroupRow
              key={row.key}
              row={row}
              draft={draft}
              appName={appName}
              isDisabled={isDisabled}
              onSetLevel={(level) => onChange(setRowLevel(draft, row, level))}
              onToggleKind={(kind) => onChange(toggleKind(draft, row, kind))}
              onToggleAll={() => onChange(toggleAllKinds(draft, row))}
            />
          ) : (
            <CanObjectRow
              key={row.key}
              row={row}
              draft={draft}
              actsAs={actsAs}
              podWideKind={podWideKind}
              isDisabled={isDisabled}
              onChange={onChange}
            />
          )
        )}
      </ul>
    </div>
  );
}

const LEGEND = "text-sm font-medium text-foreground";

/** "In": Spaces (All / Only the spaces I pick), then Projects, then the union. */
export function InChoices({
  draft,
  offer,
  rows,
  isDisabled = false,
  onChange,
}: {
  draft: ConsentDraft;
  offer: ConsentOffer;
  rows: readonly CanRow[];
  isDisabled?: boolean;
  onChange: OnChange;
}) {
  const t = consentT();
  const choices = readChoices(offer);
  const all = draft.read.spaces === "all";
  const [pickingProjects, setPickingProjects] = useState(false);
  const projectsMode = readProjectsMode(draft, pickingProjects);
  const spaceBoxes =
    !all && choices.spaces.length > 0 ? (
      <div
        role="group"
        aria-label={t("in.spaces")}
        className="grid grid-cols-1 gap-x-4 pl-7 min-[400px]:grid-cols-2"
      >
        {choices.spaces.map((s) => (
          <Checkbox
            key={s.workspaceId}
            size="sm"
            classNames={CONSENT_CHECKBOX}
            isDisabled={isDisabled}
            isSelected={
              draft.read.spaces !== "all" &&
              draft.read.spaces.includes(s.workspaceId)
            }
            onValueChange={() => onChange(toggleReadSpace(draft, s.workspaceId))}
          >
            <span className="text-sm text-foreground/85">{s.workspaceName}</span>
          </Checkbox>
        ))}
      </div>
    ) : null;
  const missing = notEverywhere(draft, rows);
  return (
    <div className="flex flex-col gap-4">
      <div role="group" className="flex flex-col gap-1" aria-label={t("in.spaces")}>
        <p className={LEGEND} aria-hidden>
          {t("in.spaces")}
        </p>
        {choices.everywhere && choices.spaces.length > 0 ? (
          <>
            <RadioGroup
              aria-label={t("in.spaces")}
              value={all ? "all" : "pick"}
              isDisabled={isDisabled}
              onValueChange={(v) =>
                onChange(setReadSpacesMode(draft, offer, v as "all" | "pick"))
              }
            >
              <Radio value="all" description={t("in.allSpacesHint")}>
                {t("in.allSpaces")}
              </Radio>
              <Radio value="pick">{t("in.pickSpaces")}</Radio>
            </RadioGroup>
            {spaceBoxes}
          </>
        ) : choices.everywhere ? (
          <p className="text-sm text-foreground/85">
            {t("in.allSpaces")}{" "}
            <span className={CAPTION}>{t("in.allSpacesHint")}</span>
          </p>
        ) : choices.spaces.length > 0 ? (
          <div className="-ml-7">{spaceBoxes}</div>
        ) : (
          <p className={CAPTION}>{t("blocked.noSpace")}</p>
        )}
        {missing.length > 0 ? (
          <p className={CAPTION}>
            {t("in.notEverywhere", { names: andList(missing) })}
          </p>
        ) : null}
        {!all && readsSpaceRecords(rows.flatMap((r) => r.permissions)) ? (
          <p className={CAPTION}>{placeReachNote("spaces")}</p>
        ) : null}
      </div>

      {offer.projectsOffered ? (
        <div role="group" className="flex flex-col gap-1" aria-label={t("in.projects")}>
          <p className={LEGEND} aria-hidden>
            {t("in.projects")}
          </p>
          {all ? (
            <p className={`flex items-start gap-1.5 ${CAPTION}`}>
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
              {t("in.everyProject")}
            </p>
          ) : (
            <>
              <RadioGroup
                aria-label={t("in.projects")}
                value={projectsMode}
                isDisabled={isDisabled}
                onValueChange={(v) => {
                  setPickingProjects(v === "pick");
                  onChange(setReadProjectsMode(draft, v as "all" | "pick" | "none"));
                }}
              >
                <Radio
                  value="all"
                  description={
                    choices.projects.length > 0
                      ? t("in.allProjectsHint")
                      : t("in.allProjectsNoneYet")
                  }
                >
                  {t("in.allProjects")}
                </Radio>
                {choices.projects.length > 0 ? (
                  <Radio value="pick">{t("in.pickProjects")}</Radio>
                ) : null}
                <Radio value="none">{t("in.noProjects")}</Radio>
              </RadioGroup>
              {projectsMode === "pick" && choices.projects.length > 0 ? (
                <div
                  role="group"
                  aria-label={t("in.projects")}
                  className="grid grid-cols-1 gap-x-4 pl-7 min-[400px]:grid-cols-2"
                >
                  {choices.projects.map((p) => (
                    <Checkbox
                      key={p.projectId}
                      size="sm"
                      classNames={CONSENT_CHECKBOX}
                      isDisabled={isDisabled}
                      isSelected={
                        draft.read.projects !== "all" &&
                        draft.read.projects.includes(p.projectId)
                      }
                      onValueChange={() =>
                        onChange(toggleReadProject(draft, p.projectId))
                      }
                    >
                      <span className="text-sm text-foreground/85">
                        {p.projectName}
                      </span>
                    </Checkbox>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {showsUnion(draft) ? (
        <p className="rounded-md bg-foreground/[0.04] px-3 py-2 text-pretty text-xs leading-relaxed text-foreground/75">
          {t("in.union")}
        </p>
      ) : null}
    </div>
  );
}

/** "It changes things in": a list of spaces and projects, never everywhere. */
export function WriteChoices({
  draft,
  offer,
  isDisabled = false,
  onChange,
}: {
  draft: ConsentDraft;
  offer: ConsentOffer;
  isDisabled?: boolean;
  onChange: OnChange;
}) {
  const t = consentT();
  const choices = writeChoices(offer);
  const viewOnly = viewOnlySpaces(offer);
  if (choices.spaces.length + choices.projects.length === 0) {
    return <p className={CAPTION}>{t("write.noPlace")}</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {choices.spaces.length > 0 ? (
        <div role="group" aria-label={t("write.spaces")} className="flex flex-col">
          <p className={LEGEND} aria-hidden>
            {t("write.spaces")}
          </p>
          <div className="grid grid-cols-1 gap-x-4 min-[400px]:grid-cols-2">
            {choices.spaces.map((s) => (
              <Checkbox
                key={s.workspaceId}
                size="sm"
                classNames={CONSENT_CHECKBOX}
                isDisabled={isDisabled}
                isSelected={draft.write.spaces.includes(s.workspaceId)}
                onValueChange={() =>
                  onChange(toggleWritePlace(draft, "space", s.workspaceId))
                }
              >
                <span className="flex items-center gap-1.5 text-sm text-foreground/85">
                  {s.workspaceName}
                  {s.templateSlug && offer.templates.includes(s.templateSlug) ? (
                    <Chip size="sm" variant="flat">
                      {t("write.asked")}
                    </Chip>
                  ) : null}
                </span>
              </Checkbox>
            ))}
          </div>
        </div>
      ) : null}
      {choices.projects.length > 0 ? (
        <div role="group" aria-label={t("write.projects")} className="flex flex-col">
          <p className={LEGEND} aria-hidden>
            {t("write.projects")}
          </p>
          <div className="grid grid-cols-1 gap-x-4 min-[400px]:grid-cols-2">
            {choices.projects.map((p) => (
              <Checkbox
                key={p.projectId}
                size="sm"
                classNames={CONSENT_CHECKBOX}
                isDisabled={isDisabled}
                isSelected={draft.write.projects.includes(p.projectId)}
                onValueChange={() =>
                  onChange(toggleWritePlace(draft, "project", p.projectId))
                }
              >
                <span className="text-sm text-foreground/85">{p.projectName}</span>
              </Checkbox>
            ))}
          </div>
        </div>
      ) : null}
      {viewOnly.length > 0 ? (
        <p className={CAPTION}>
          {t("write.viewOnly", {
            names: andList(viewOnly.map((s) => s.workspaceName)),
            n: viewOnly.length,
          })}
        </p>
      ) : null}
      <p className={CAPTION}>{t("write.noEverywhere")}</p>
    </div>
  );
}

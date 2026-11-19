"use client";

/**
 * What each line's door opens (design A): the choices of "It can", "In"
 * and "It changes things in", as plain content. `AccessLines` hosts them in
 * a `ChoiceSheet`; a test renders them directly. Every change goes through
 * the pure rules of `consent-access`, so nothing here can widen the offer.
 */

import { useId, useState, type ReactNode } from "react";
import { Checkbox, Chip, Radio, RadioGroup } from "@heroui/react";
import { Check, ChevronRight } from "lucide-react";
import {
  KINDS_ROW,
  andList,
  isWriteTier,
  midSentence,
  notEverywhere,
  readChoices,
  readProjectsMode,
  rowLevel,
  setKindLevel,
  setPermission,
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
import { CONSENT_CHECKBOX, CONSENT_RADIO, LevelControl } from "./LevelControl";
import { KindsGroupRow } from "./KindsGroupRow";
import { consentT } from "./copy";

type OnChange = (next: ConsentDraft) => void;

const CAPTION = "text-pretty text-xs leading-relaxed text-foreground/65";
const LEGEND = "text-sm font-medium text-foreground";
/** Focus is an outline only (ui-rules), never a ring over a removed outline. */
const FOCUS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/** One disclosure: a chevron that points right, and down (90°) when open. */
export function Disclosure({
  label,
  children,
  className = "",
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className={`flex flex-col ${className}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className={`-mx-1 flex min-h-10 items-center gap-1 self-start rounded-md px-1 text-xs text-foreground/75 hover:text-foreground ${FOCUS}`}
      >
        <ChevronRight
          aria-hidden
          className={`h-3.5 w-3.5 shrink-0 ${open ? "rotate-90" : ""}`}
        />
        {label}
      </button>
      <div id={id} hidden={!open} className={open ? "flex flex-col" : "hidden"}>
        {children}
      </div>
    </div>
  );
}

/** "Pillars, Journey stages, Series, Platforms +7 more": what it also sees. */
function alsoSeeNames(draft: ConsentDraft, row: ConsentObject): string {
  const t = consentT();
  const given = row.members.filter((m) => rowLevel(draft, m) !== "off");
  const names = (given.length > 0 ? given : row.members).map((m) => m.label);
  return names.length <= 4
    ? andList(names)
    : andList([...names.slice(0, 3), t("can.more", { n: names.length - 3 })]);
}

/**
 * A row's words: its decision line, what it also sees, or what it may do,
 * said once ("Edit jobs", not "Edit jobs and read jobs": a write includes
 * reading what it writes).
 */
function rowWords(
  draft: ConsentDraft,
  row: ConsentObject,
  actsAs: ActsAs
): string {
  if (row.key === ALSO_SEE) return alsoSeeNames(draft, row);
  if (row.decisions) return decideLine(row, actsAs);
  const perms = row.permissions.map((p) => p.permission);
  const writes = perms.filter(isWriteTier);
  const said = (writes.length > 0 ? writes : perms).map(permissionLabel);
  return andList(said.map((l, i) => (i === 0 ? l : midSentence(l))));
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
  const t = consentT();
  const id = useId();
  const [open, setOpen] = useState(false);
  const folded = row.key === ALSO_SEE;
  const reasons = [
    ...new Set(
      row.permissions
        .map((p) => p.reason?.trim())
        .filter((r): r is string => !!r)
    ),
  ];
  return (
    <li className="flex flex-col py-1" data-object={row.key}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-detail`}
          onClick={() => setOpen((o) => !o)}
          className={`-mx-1 flex min-h-10 min-w-0 flex-1 basis-40 items-center gap-1.5 rounded-md px-1 text-left hover:bg-foreground/[0.04] ${FOCUS}`}
        >
          <ChevronRight
            aria-hidden
            className={`h-4 w-4 shrink-0 text-foreground/65 ${open ? "rotate-90" : ""}`}
          />
          <span className="flex min-w-0 flex-col">
            <span className="text-sm font-medium text-foreground/90">
              {row.label}
            </span>
            <span className="text-xs text-foreground/65">
              {rowWords(draft, row, actsAs)}
            </span>
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
            {reasons.map((r) => (
              <p
                key={r}
                className="text-pretty text-xs leading-relaxed text-foreground/75"
              >
                {/* The developer's words, as text: why it asks. */}
                <span className="text-foreground/65">
                  {t("reason.prefix")}{" "}
                </span>
                {r}
              </p>
            ))}
            {podWideKind(row) && draft.read.spaces !== "all" ? (
              <p className={CAPTION}>{podWideNote(row)}</p>
            ) : null}
            {/* One permission at a time (create posts, not delete them):
                today's Customize, inside the row it belongs to. */}
            <Disclosure label={t("fine.toggle")}>
              <div
                role="group"
                aria-label={t("fine.label", { object: row.label })}
                className="flex flex-col"
              >
                {row.permissions.map((p) => (
                  <Checkbox
                    key={p.permission}
                    size="sm"
                    classNames={CONSENT_CHECKBOX}
                    isDisabled={isDisabled}
                    isSelected={draft.permissions.has(p.permission)}
                    onValueChange={(on) =>
                      onChange(setPermission(draft, p.permission, on))
                    }
                  >
                    <span className="text-sm text-foreground/85">
                      {permissionLabel(p.permission)}{" "}
                      <span className="font-mono text-[11px] text-foreground/65">
                        {p.permission}
                      </span>
                    </span>
                  </Checkbox>
                ))}
              </div>
            </Disclosure>
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
              podWideKinds={podWideKinds}
              isDisabled={isDisabled}
              onSetLevel={(level) => onChange(setRowLevel(draft, row, level))}
              onToggleKind={(kind) => onChange(toggleKind(draft, row, kind))}
              onSetKindLevel={(kind, level) =>
                onChange(setKindLevel(draft, row, kind, level))
              }
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

/** A checklist of places, under the radio that reveals it. */
function PlaceChecks({
  label,
  places,
  isSelected,
  onToggle,
  isDisabled,
}: {
  label: string;
  places: ReadonlyArray<{ id: string; name: string }>;
  isSelected: (id: string) => boolean;
  onToggle: (id: string) => void;
  isDisabled: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="grid grid-cols-1 gap-x-4 pl-7 min-[400px]:grid-cols-2"
    >
      {places.map((p) => (
        <Checkbox
          key={p.id}
          size="sm"
          classNames={CONSENT_CHECKBOX}
          isDisabled={isDisabled}
          isSelected={isSelected(p.id)}
          onValueChange={() => onToggle(p.id)}
        >
          <span className="text-sm text-foreground/85">{p.name}</span>
        </Checkbox>
      ))}
    </div>
  );
}

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
  const id = useId();
  const choices = readChoices(offer);
  const all = draft.read.spaces === "all";
  const [pickingProjects, setPickingProjects] = useState(false);
  const projectsMode = readProjectsMode(draft, pickingProjects);
  const spaces = choices.spaces.map((s) => ({
    id: s.workspaceId,
    name: s.workspaceName,
  }));
  const spaceChecks = (
    <PlaceChecks
      label={t("in.pickSpaces")}
      places={spaces}
      isDisabled={isDisabled}
      isSelected={(sid) =>
        draft.read.spaces !== "all" && draft.read.spaces.includes(sid)
      }
      onToggle={(sid) => onChange(toggleReadSpace(draft, sid))}
    />
  );
  const projectChecks = (
    <PlaceChecks
      label={t("in.pickProjects")}
      places={choices.projects.map((p) => ({
        id: p.projectId,
        name: p.projectName,
      }))}
      isDisabled={isDisabled}
      isSelected={(pid) =>
        draft.read.projects !== "all" && draft.read.projects.includes(pid)
      }
      onToggle={(pid) => onChange(toggleReadProject(draft, pid))}
    />
  );
  const missing = notEverywhere(draft, rows, offer);
  return (
    <div className="flex flex-col gap-4">
      <div
        role="group"
        aria-labelledby={`${id}-sp`}
        className="flex flex-col gap-1"
      >
        <p id={`${id}-sp`} className={LEGEND}>
          {t("in.spaces")}
        </p>
        {choices.everywhere && choices.spaces.length > 0 ? (
          <RadioGroup
            aria-labelledby={`${id}-sp`}
            value={all ? "all" : "pick"}
            isDisabled={isDisabled}
            onValueChange={(v) =>
              onChange(setReadSpacesMode(draft, offer, v as "all" | "pick"))
            }
          >
            <Radio
              value="all"
              classNames={CONSENT_RADIO}
              description={t("in.allSpacesHint")}
            >
              {t("in.allSpaces")}
            </Radio>
            <Radio value="pick" classNames={CONSENT_RADIO}>
              {t("in.pickSpaces")}
            </Radio>
            {/* The checklist sits under the choice that reveals it. */}
            {!all ? spaceChecks : null}
          </RadioGroup>
        ) : choices.everywhere ? (
          <p className="text-sm text-foreground/85">
            {t("in.allSpaces")}{" "}
            <span className={CAPTION}>{t("in.allSpacesHint")}</span>
          </p>
        ) : choices.spaces.length > 0 ? (
          <div className="-ml-7">{spaceChecks}</div>
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
        <div
          role="group"
          aria-labelledby={`${id}-pr`}
          className="flex flex-col gap-1"
        >
          <p id={`${id}-pr`} className={LEGEND}>
            {t("in.projects")}
          </p>
          {all ? (
            <p className={`flex items-start gap-1.5 ${CAPTION}`}>
              <Check
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary"
                aria-hidden
              />
              {t("in.allIncludesProjects")}
            </p>
          ) : (
            <RadioGroup
              aria-labelledby={`${id}-pr`}
              value={projectsMode}
              isDisabled={isDisabled}
              onValueChange={(v) => {
                setPickingProjects(v === "pick");
                onChange(
                  setReadProjectsMode(draft, v as "all" | "pick" | "none")
                );
              }}
            >
              <Radio
                value="all"
                classNames={CONSENT_RADIO}
                description={
                  choices.projects.length > 0
                    ? t("in.allProjectsHint")
                    : t("in.allProjectsNoneYet")
                }
              >
                {t("in.allProjects")}
              </Radio>
              {choices.projects.length > 0 ? (
                <Radio value="pick" classNames={CONSENT_RADIO}>
                  {t("in.pickProjects")}
                </Radio>
              ) : null}
              {/* Directly under "Only the projects I pick", as for spaces. */}
              {projectsMode === "pick" && choices.projects.length > 0
                ? projectChecks
                : null}
              <Radio value="none" classNames={CONSENT_RADIO}>
                {t("in.noProjects")}
              </Radio>
            </RadioGroup>
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

/**
 * "It changes things in": a list of spaces and projects, never everywhere.
 * `asked` marks the places the app asked for (its templates, or a short
 * ask's own space); `within` limits the list (a short ask offers only places
 * it can already look in).
 */
export function WriteChoices({
  draft,
  offer,
  isDisabled = false,
  onChange,
  asked,
  within,
}: {
  draft: ConsentDraft;
  offer: ConsentOffer;
  isDisabled?: boolean;
  onChange: OnChange;
  asked?: readonly string[];
  within?: {
    spaces: readonly string[] | "all";
    projects: readonly string[] | "all";
  };
}) {
  const t = consentT();
  const choices = writeChoices(offer);
  const keep = (list: readonly string[] | "all" | undefined, id: string) =>
    !list || list === "all" || list.includes(id);
  const spaces = choices.spaces.filter((s) =>
    keep(within?.spaces, s.workspaceId)
  );
  const projects = choices.projects.filter((p) =>
    keep(within?.projects, p.projectId)
  );
  const viewOnly = viewOnlySpaces(offer);
  const isAsked = (s: { workspaceId: string; templateSlug?: string | null }) =>
    asked
      ? asked.includes(s.workspaceId)
      : !!s.templateSlug && offer.templates.includes(s.templateSlug);
  if (spaces.length + projects.length === 0) {
    return <p className={CAPTION}>{t("write.noPlace")}</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {spaces.length > 0 ? (
        <div
          role="group"
          aria-label={t("write.spaces")}
          className="flex flex-col"
        >
          <p className={LEGEND} aria-hidden>
            {t("in.spaces")}
          </p>
          <div className="grid grid-cols-1 gap-x-4 min-[400px]:grid-cols-2">
            {spaces.map((s) => (
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
                  {isAsked(s) ? (
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
      {projects.length > 0 ? (
        <div
          role="group"
          aria-label={t("write.projects")}
          className="flex flex-col"
        >
          <p className={LEGEND} aria-hidden>
            {t("in.projects")}
          </p>
          <div className="grid grid-cols-1 gap-x-4 min-[400px]:grid-cols-2">
            {projects.map((p) => (
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
                <span className="text-sm text-foreground/85">
                  {p.projectName}
                </span>
              </Checkbox>
            ))}
          </div>
        </div>
      ) : null}
      {viewOnly.length > 0 && !within ? (
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

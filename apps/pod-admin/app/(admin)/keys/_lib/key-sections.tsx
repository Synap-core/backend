"use client";

/**
 * The sections of the ONE key page, in HeroUI (keys plan §3.2, Decision 1).
 * pod-admin cannot import the web key editor (`@synap-core/web` is private to
 * synap-app), so it lays out the SAME model: `KEY_DRAFT_SECTIONS` in their
 * order, the templates, the uses, the grant matrix (`buildGrantSections`,
 * `toggleGrant`), the review sentence and marks (`describeKey`) and the
 * problems (`validateKeyDraft`, `describeKeyProblem`). Nothing here decides
 * what a key may be.
 *
 * Two hosts: New key (`/keys/new`) and the Review of a key a CLI asked for
 * (`/keys/requests/[id]`), where `ceiling` lets the person narrow the key,
 * never widen it, and there is no "Start from".
 */

import {
  Button,
  Checkbox,
  Chip,
  Input,
  Radio,
  RadioGroup,
  Textarea,
} from "@heroui/react";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  GRANT_ACTIONS,
  KEY_AGENT_DOOR,
  KEY_DRAFT_SECTIONS,
  KEY_POWERFUL_ACTIONS,
  KEY_USES,
  buildGrantSections,
  describeKey,
  describeKeyProblem,
  grantActionLabel,
  grantLifetime,
  grantSubjectLabel,
  isFullAccess,
  isImpliedByAllKinds,
  keyDraftFromTemplate,
  setGrantLifetime,
  setGrantPermissions,
  setGrantProjects,
  setGrantWorkspaces,
  setKeyGrant,
  setKeyUses,
  toggleGrant,
  type GrantAction,
  type GrantRole,
  type GrantSectionKind,
  type KeyCeiling,
  type KeyDraft,
  type KeyDraftSectionId,
  type KeyDraftValidation,
} from "@synap-core/types/grants";
import { resolveKeyUseLabel } from "@synap-core/types/vocabulary";
import {
  cellAllowed,
  lifetimeChoices,
  lifetimeLabel,
  keyUseAllowed,
} from "./key-form-model";

const SECTION_LABEL = Object.fromEntries(
  KEY_DRAFT_SECTIONS.map((s) => [s.id, s.label])
) as Record<KeyDraftSectionId, string>;

/** The anchor a problem's link opens (`describeKeyProblem(p).section`). */
export const sectionAnchor = (s: KeyDraftSectionId) => `key-section-${s}`;

export interface KeyPlace {
  readonly id: string;
  readonly name: string;
}

function Section({
  id,
  hint,
  children,
}: {
  id: KeyDraftSectionId;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={sectionAnchor(id)}
      aria-labelledby={`${sectionAnchor(id)}-h`}
      className="flex scroll-mt-6 flex-col gap-3 border-t border-foreground/[0.06] pt-5 first:border-t-0 first:pt-0"
    >
      <div className="flex flex-col gap-0.5">
        <h2
          id={`${sectionAnchor(id)}-h`}
          className="text-[14px] font-medium text-foreground"
        >
          {SECTION_LABEL[id]}
        </h2>
        {hint ? <p className="text-[12px] text-foreground/65">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** A choice drawn as a card (a template, a holder). */
export function ChoiceCard({
  title,
  description,
  selected,
  danger,
  mark,
  onPress,
}: {
  title: string;
  description: string;
  selected: boolean;
  danger?: boolean;
  mark?: ReactNode;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onPress}
      className={[
        "flex h-full flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors",
        selected
          ? "border-primary/40 bg-primary/[0.07] ring-1 ring-inset ring-primary/30"
          : "border-foreground/10 bg-foreground/[0.03] hover:bg-foreground/[0.06]",
      ].join(" ")}
    >
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="text-[12.5px] font-medium text-foreground">
          {title}
        </span>
        {danger ? (
          <Chip size="sm" color="danger" variant="flat">
            Full access
          </Chip>
        ) : null}
        {mark}
      </span>
      <span className="text-[11.5px] text-foreground/65">{description}</span>
    </button>
  );
}

export interface KeySectionsProps {
  readonly draft: KeyDraft;
  readonly onChange: (next: KeyDraft) => void;
  /** Kinds offered as rows under Records. */
  readonly kinds: readonly GrantSectionKind[];
  /** "Start from": built-ins then stored roles. Omitted = no such section (a request). */
  readonly templates?: readonly GrantRole[];
  /** The person's stored roles could not be read: Start from says so. */
  readonly rolesFailed?: { readonly retry: () => void } | null;
  /** Spaces and projects the key may be narrowed to. */
  readonly spaces: readonly KeyPlace[];
  readonly projects: readonly KeyPlace[];
  /** The spaces or projects could not be read: Where says so. */
  readonly placesFailed?: { readonly retry: () => void } | null;
  /** A key made for one space: Where is that space and nothing else. */
  readonly pinnedSpace?: KeyPlace | null;
  /** A CLI request's ceiling: narrow, never widen. */
  readonly ceiling?: KeyCeiling;
  /** Rendered at the end of "Name and note" (who holds the key). */
  readonly holderSlot?: ReactNode;
}

export function KeySections(props: KeySectionsProps) {
  const {
    draft,
    onChange,
    kinds,
    templates,
    rolesFailed,
    spaces,
    projects,
    placesFailed,
    pinnedSpace,
    ceiling,
    holderSlot,
  } = props;
  const grant = draft.grant;
  const setGrant = (g: KeyDraft["grant"]) => onChange(setKeyGrant(draft, g));
  const full = isFullAccess(grant);
  const kindSlugs = kinds.map((k) => k.slug);
  const sections = buildGrantSections({ draft: grant, kinds });
  // A name the template filled follows the next template; a typed one stays.
  const templateName = templates?.find((t) => t.id === draft.templateId)?.name;
  const untyped = (d: KeyDraft) => (d.name === templateName ? "" : d.name);

  return (
    <div className="flex flex-col gap-5">
      {templates ? (
        <Section
          id="start"
          hint="A template fills every section below. You can change any of it."
        >
          <ul className="grid gap-2 sm:grid-cols-2">
            {templates.map((t) => (
              <li key={t.id}>
                <ChoiceCard
                  title={t.name}
                  description={t.description}
                  selected={draft.templateId === t.id}
                  danger={isFullAccess(t.grant)}
                  mark={
                    t.stored ? (
                      <span className="text-[11px] text-foreground/60">
                        Yours
                      </span>
                    ) : null
                  }
                  onPress={() =>
                    onChange(
                      keyDraftFromTemplate(t, {
                        ...draft,
                        name: untyped(draft),
                      })
                    )
                  }
                />
              </li>
            ))}
            <li>
              {/* A door, not a key (Decision 3): an AI gets its own limits as an agent. */}
              <Link
                href="/connect"
                className="flex h-full flex-col gap-1 rounded-lg border border-dashed border-foreground/15 px-3 py-2.5 text-left hover:bg-foreground/[0.04]"
              >
                <span className="text-[12.5px] font-medium text-foreground">
                  {KEY_AGENT_DOOR.name}
                </span>
                <span className="text-[11.5px] text-foreground/65">
                  {KEY_AGENT_DOOR.description}
                </span>
              </Link>
            </li>
            <li>
              <ChoiceCard
                title="Start from scratch"
                description="Nothing ticked: you pick every permission yourself."
                selected={!draft.templateId}
                onPress={() =>
                  onChange({
                    ...setKeyGrant(draft, setGrantPermissions(grant, [])),
                    templateId: null,
                    name: untyped(draft),
                  })
                }
              />
            </li>
          </ul>
          {rolesFailed ? (
            <div
              role="alert"
              className="flex items-center justify-between gap-2 text-[12px] text-danger"
            >
              <span>Your saved roles couldn&apos;t be loaded.</span>
              <Button size="sm" variant="flat" onPress={rolesFailed.retry}>
                Retry
              </Button>
            </div>
          ) : null}
        </Section>
      ) : null}

      <Section id="name">
        <Input
          label="Name"
          size="sm"
          isRequired
          placeholder="Portfolio site"
          value={draft.name}
          onValueChange={(name) => onChange({ ...draft, name })}
        />
        <Textarea
          label="Where will you keep it?"
          size="sm"
          minRows={2}
          placeholder="The GitHub secret SYNAP_OBS_KEY of the backend repo"
          description="Saved with the key, so you know where to change it later. Never the key itself."
          value={draft.note ?? ""}
          onValueChange={(note) => onChange({ ...draft, note })}
        />
        {holderSlot}
      </Section>

      <Section id="uses" hint="This decides which doors the key may enter.">
        <div className="flex flex-col gap-1.5">
          {KEY_USES.map((use) => {
            const on = draft.uses.includes(use.id);
            return (
              <Checkbox
                key={use.id}
                size="sm"
                isSelected={on}
                isDisabled={!on && !keyUseAllowed(ceiling, use.id)}
                onValueChange={(next) =>
                  onChange(
                    setKeyUses(
                      draft,
                      next
                        ? [...draft.uses, use.id]
                        : draft.uses.filter((u) => u !== use.id)
                    )
                  )
                }
              >
                <span className="text-[12.5px]">
                  {resolveKeyUseLabel(use.id)}
                </span>
              </Checkbox>
            );
          })}
        </div>
      </Section>

      <Section
        id="access"
        hint={
          full
            ? "Full access: everything below is granted, approving and deleting included."
            : "Tick what the key may read, create, change or delete."
        }
      >
        {grant.permissions.length === 0 ? (
          <p className="rounded-md bg-foreground/[0.04] px-3 py-2 text-[12px] text-foreground/75">
            Pick at least one thing it may touch: tick a row below, or start
            from a template.
          </p>
        ) : null}
        <div className="flex flex-col gap-4 overflow-x-auto">
          {sections.map((s) => (
            <div key={s.id} className="min-w-[30rem]">
              <div className="grid grid-cols-[1fr_repeat(4,4.5rem)] items-end gap-x-2 border-b border-foreground/[0.06] pb-1">
                <span className="text-[12px] font-medium text-foreground/85">
                  {s.label}
                </span>
                {GRANT_ACTIONS.map((a) => (
                  <span
                    key={a}
                    className="text-center text-[11px] text-foreground/60"
                  >
                    {grantActionLabel(a)}
                  </span>
                ))}
              </div>
              {s.rows.map((row) => (
                <div
                  key={row.key}
                  className="grid grid-cols-[1fr_repeat(4,4.5rem)] items-center gap-x-2 py-1"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="text-[12.5px] text-foreground">
                      {row.label}
                    </span>
                    {row.description ? (
                      <span className="truncate text-[11px] text-foreground/60">
                        {row.description}
                      </span>
                    ) : null}
                  </span>
                  {GRANT_ACTIONS.map((a: GrantAction) => {
                    if (!row.actions.includes(a))
                      return <span key={a} aria-hidden />;
                    const cell = {
                      subject: row.subject,
                      kind: row.kind,
                      action: a,
                    };
                    const on = row.granted.includes(a);
                    const implied = isImpliedByAllKinds(grant, cell);
                    return (
                      <span key={a} className="flex justify-center">
                        <Checkbox
                          size="sm"
                          aria-label={`${grantActionLabel(a)} ${row.label}`}
                          isSelected={on}
                          isDisabled={
                            implied || (!on && !cellAllowed(ceiling, cell))
                          }
                          onValueChange={(next) =>
                            setGrant(
                              toggleGrant(grant, cell, next, {
                                kinds: kindSlugs,
                              })
                            )
                          }
                        />
                      </span>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}
        </div>
        <fieldset className="flex flex-col gap-1.5 rounded-lg border border-foreground/10 px-3 py-2.5">
          <legend className="px-1 text-[12px] font-medium text-foreground/85">
            Powerful actions
          </legend>
          <p className="text-[11.5px] text-foreground/65">
            Never part of read, create, update or delete. Tick one only when the
            key needs it.
          </p>
          {KEY_POWERFUL_ACTIONS.map((a) => {
            const on = full || grant.permissions.includes(a.pattern);
            const allowed =
              !ceiling ||
              ceiling.grant.permissions.some(
                (p) => p === "*" || p === a.pattern
              );
            return (
              <div key={a.pattern} className="flex items-center gap-2">
                <Checkbox
                  size="sm"
                  isSelected={on}
                  isDisabled={full || (!on && !allowed)}
                  onValueChange={(next) =>
                    setGrant(
                      setGrantPermissions(
                        grant,
                        next
                          ? [...grant.permissions, a.pattern]
                          : grant.permissions.filter((p) => p !== a.pattern)
                      )
                    )
                  }
                >
                  <span className="text-[12.5px]">
                    {grantActionLabel(a.verb)} {grantSubjectLabel(a.subject)}
                  </span>
                </Checkbox>
                {on ? (
                  <Chip size="sm" color="danger" variant="flat">
                    {full ? "Through full access" : "Powerful"}
                  </Chip>
                ) : null}
              </div>
            );
          })}
        </fieldset>
      </Section>

      <Section id="where">
        {pinnedSpace ? (
          <p className="text-[12.5px] text-foreground/80">
            Only in <span className="font-medium">{pinnedSpace.name}</span>. A
            key made for a space never reaches another.
          </p>
        ) : placesFailed ? (
          <div
            role="alert"
            className="flex items-center justify-between gap-2 text-[12px] text-danger"
          >
            <span>Your spaces and projects couldn&apos;t be loaded.</span>
            <Button size="sm" variant="flat" onPress={placesFailed.retry}>
              Retry
            </Button>
          </div>
        ) : (
          <>
            <p className="text-[12.5px] text-foreground/80">
              {(grant.workspaceIds?.length ?? 0) +
                (grant.projectIds?.length ?? 0) >
              0
                ? "Only where ticked below."
                : "Anywhere you can reach. Tick a space or a project to narrow it."}
            </p>
            <PlacePicker
              label="Spaces"
              places={spaces}
              ids={grant.workspaceIds ?? []}
              onChange={(ids) => setGrant(setGrantWorkspaces(grant, ids))}
            />
            <PlacePicker
              label="Projects"
              places={projects}
              ids={grant.projectIds ?? []}
              onChange={(ids) => setGrant(setGrantProjects(grant, ids))}
            />
          </>
        )}
      </Section>

      <Section id="lifetime">
        <LifetimePicker
          draft={draft}
          ceiling={ceiling}
          onChange={(days) => setGrant(setGrantLifetime(grant, days))}
        />
        {grantLifetime(grant).kind === "never" ? (
          <p
            role="note"
            className="rounded-md bg-warning/10 px-3 py-2 text-[12px] text-warning"
          >
            A key that never expires works until someone revokes it, even if it
            leaks. Prefer a year.
          </p>
        ) : null}
      </Section>
    </div>
  );
}

function PlacePicker({
  label,
  places,
  ids,
  onChange,
}: {
  label: string;
  places: readonly KeyPlace[];
  ids: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  if (places.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-foreground/85">
        {label}
      </span>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {places.map((p) => {
          const on = ids.includes(p.id);
          return (
            <Checkbox
              key={p.id}
              size="sm"
              isSelected={on}
              onValueChange={(next) =>
                onChange(
                  next ? [...ids, p.id] : ids.filter((id) => id !== p.id)
                )
              }
            >
              <span className="text-[12.5px]">{p.name}</span>
            </Checkbox>
          );
        })}
      </div>
    </div>
  );
}

function LifetimePicker({
  draft,
  ceiling,
  onChange,
}: {
  draft: KeyDraft;
  ceiling?: KeyCeiling;
  onChange: (days: number | null) => void;
}) {
  const choices = lifetimeChoices(ceiling);
  const life = grantLifetime(draft.grant);
  const current = life.kind === "never" ? null : life.days;
  const isChoice = choices.includes(current);
  const value = isChoice ? String(current) : "custom";
  return (
    <div className="flex flex-col gap-2">
      <RadioGroup
        aria-label="Expires"
        orientation="horizontal"
        size="sm"
        value={value}
        onValueChange={(v) => {
          if (v === "custom") return onChange(current ?? 90);
          onChange(v === "null" ? null : Number(v));
        }}
      >
        {choices.map((d) => (
          <Radio key={String(d)} value={String(d)}>
            {lifetimeLabel(d)}
          </Radio>
        ))}
        <Radio value="custom">After…</Radio>
      </RadioGroup>
      {value === "custom" ? (
        <Input
          type="number"
          size="sm"
          className="max-w-[12rem]"
          label="Days"
          min={1}
          value={current === null ? "" : String(current)}
          onValueChange={(v) => {
            const n = Number(v);
            if (Number.isFinite(n) && v.trim() !== "") onChange(n);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Section 7, sticky at the bottom of the column: the key in words, its danger
 * marks, what still stops it, and the one primary. A long matrix scrolls
 * under it; the decision stays in view.
 */
export function KeyReviewBar({
  draft,
  validation,
  kindNames,
  primaryLabel,
  onPrimary,
  busy,
  error,
  secondary,
}: {
  draft: KeyDraft;
  validation: KeyDraftValidation;
  kindNames?: Readonly<Record<string, string>>;
  primaryLabel: string;
  onPrimary: () => void;
  busy: boolean;
  /** The door's refusal, in its words. */
  error?: string | null;
  /** A second action beside the primary (Deny on a request). */
  secondary?: ReactNode;
}) {
  const d = describeKey(draft, { kindNames });
  return (
    <section
      id={sectionAnchor("review")}
      aria-labelledby={`${sectionAnchor("review")}-h`}
      className="sticky bottom-0 z-10 mt-2 flex flex-col gap-2 rounded-lg border border-foreground/10 bg-background/95 px-4 py-3 backdrop-blur"
    >
      <h2
        id={`${sectionAnchor("review")}-h`}
        className="text-[13px] font-medium text-foreground"
      >
        {SECTION_LABEL.review}
      </h2>
      <p
        className={`text-[12.5px] ${d.summary.full ? "text-danger" : "text-foreground/85"}`}
      >
        {d.sentence}
      </p>
      {d.marks.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {d.marks.map((m) => (
            <Chip
              key={m.code}
              size="sm"
              variant="flat"
              color={m.code === "never-expires" ? "warning" : "danger"}
            >
              {m.label}
            </Chip>
          ))}
        </div>
      ) : null}
      {!validation.ok ? (
        <ul className="flex flex-col gap-0.5">
          {validation.problems.map((p, i) => {
            const { section, text } = describeKeyProblem(p);
            return (
              <li key={i} className="text-[12px] text-foreground/75">
                <a
                  href={`#${sectionAnchor(section)}`}
                  className="underline decoration-foreground/30 underline-offset-2 hover:text-foreground"
                >
                  {SECTION_LABEL[section]}
                </a>
                : {text}
              </li>
            );
          })}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {secondary}
        <Button
          color="primary"
          size="sm"
          radius="md"
          isDisabled={!validation.ok || busy}
          isLoading={busy}
          onPress={onPrimary}
        >
          {primaryLabel}
        </Button>
      </div>
    </section>
  );
}

"use client";

/**
 * The New key page's four steps, in HeroUI (decision a29a40d4, key pages plan
 * 447800fe §5.1). pod-admin cannot import the web key editor (`@synap-core/web`
 * is private to synap-app), so it lays out the SAME model: `KEY_DRAFT_STEPS`
 * in their order and which one is open (`keyStepStates`), where a key acts
 * and who holds it (`KEY_SCOPES`, `keyHoldersForScope`), the templates that
 * work there (`templatesForScope`), the families at one level
 * (`ACCESS_FAMILIES`, `familyAccess`, `setFamilyLevel`, `familyParts`), the
 * sentence and marks (`describeKey`) and the problems (`describeKeyProblem`).
 * Nothing here decides what a key may be.
 *
 * An answered step closes into one line with "Change"; the next one opens.
 * "What it can do" closes into its families as marks, with "Adjust".
 *
 * Step 3's body is `./key-access.tsx` (`AccessSummary`, `AccessEditor`),
 * also the body of a key request's Review ("Narrow it", under the request's
 * ceiling) and of a key's own page ("Change").
 */

import {
  Button,
  Chip,
  Input,
  Select,
  SelectItem,
  Textarea,
} from "@heroui/react";
import { Check } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import {
  KEY_AGENT_DOOR,
  KEY_DRAFT_STEPS,
  KEY_SCOPES,
  describeKey,
  describeKeyProblem,
  isFullAccess,
  type GrantRole,
  type KeyDraft,
  type KeyDraftStepId,
  type KeyDraftValidation,
  type KeyHolderChoice,
  type KeyScope,
} from "@synap-core/types/grants";

export interface KeyPlace {
  readonly id: string;
  readonly name: string;
}

const STEP_LABEL = Object.fromEntries(
  KEY_DRAFT_STEPS.map((s) => [s.id, s.label])
) as Record<KeyDraftStepId, string>;

/** The anchor a problem's link opens (`describeKeyProblem(p).step`). */
export const stepAnchor = (s: KeyDraftStepId) => `key-step-${s}`;

/** A step's place in the ladder: answered (closed), the one open, or later. */
export type KeyStepView = "closed" | "open" | "later";

/**
 * One step. Closed: a mark, its title and its answer on one line, and
 * "Change". Open: its title, its hint, its controls. Later: its title only,
 * quiet, so the person sees what is still to come.
 */
export function KeyStep({
  id,
  view,
  summary,
  changeLabel = "Change",
  onChange,
  children,
}: {
  id: KeyDraftStepId;
  view: KeyStepView;
  /** A closed step's answer. */
  summary?: ReactNode;
  changeLabel?: string;
  onChange?: () => void;
  children?: ReactNode;
}) {
  const step = KEY_DRAFT_STEPS.find((s) => s.id === id)!;
  const n = KEY_DRAFT_STEPS.indexOf(step) + 1;
  const headingId = `${stepAnchor(id)}-h`;
  return (
    <section
      id={stepAnchor(id)}
      aria-labelledby={headingId}
      data-key-step={id}
      data-key-step-view={view}
      className="flex scroll-mt-6 flex-col gap-3 border-t border-foreground/[0.06] py-4 first:border-t-0 first:pt-0"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span
            aria-hidden
            className={[
              "mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium ring-1 ring-inset",
              view === "closed"
                ? "bg-primary/10 text-primary ring-primary/25"
                : view === "open"
                  ? "bg-foreground/[0.06] text-foreground ring-foreground/20"
                  : "text-foreground/45 ring-foreground/10",
            ].join(" ")}
          >
            {view === "closed" ? (
              <Check className="h-3 w-3" strokeWidth={2.5} />
            ) : (
              n
            )}
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2
              id={headingId}
              className={`text-[14px] font-medium ${view === "later" ? "text-foreground/45" : "text-foreground"}`}
            >
              {step.label}
            </h2>
            {view === "open" ? (
              <p className="text-[12px] text-foreground/65">{step.hint}</p>
            ) : view === "closed" && summary ? (
              <div className="text-[12.5px] text-foreground/80">{summary}</div>
            ) : null}
          </div>
        </div>
        {view === "closed" && onChange ? (
          <Button
            size="sm"
            variant="light"
            radius="md"
            className="shrink-0"
            onPress={onChange}
          >
            {changeLabel}
          </Button>
        ) : null}
      </div>
      {view === "open" ? <div className="pl-7">{children}</div> : null}
    </section>
  );
}

/** A choice drawn as a card (a scope, a holder, a template). */
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
  /** Full access: the title is red. Never a second "Full access" badge (finding 2ad1f548). */
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
        "flex h-full w-full flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        selected
          ? "border-primary/40 bg-primary/[0.07] ring-1 ring-inset ring-primary/30"
          : "border-foreground/10 bg-foreground/[0.03] hover:bg-foreground/[0.06]",
      ].join(" ")}
    >
      <span className="flex flex-wrap items-center gap-1.5">
        <span
          className={`text-[12.5px] font-medium ${danger ? "text-danger" : "text-foreground"}`}
        >
          {title}
        </span>
        {mark}
      </span>
      <span className="text-[11.5px] text-foreground/65">{description}</span>
    </button>
  );
}

function LoadFailed({ what, retry }: { what: string; retry: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-2 text-[12px] text-danger"
    >
      <span>{what} couldn&apos;t be loaded.</span>
      <Button size="sm" variant="flat" onPress={retry}>
        Retry
      </Button>
    </div>
  );
}

// ─── 1. Where it acts ──────────────────────────────────────────────────────

/** "The whole pod", "Builder", "Website relaunch" — a closed step 1's place. */
export function placeWords(
  scope: KeyScope,
  placeId: string | null,
  spaces: readonly KeyPlace[],
  projects: readonly KeyPlace[]
): string {
  if (scope === "pod") return KEY_SCOPES[0]!.label;
  const list = scope === "space" ? spaces : projects;
  const found = list.find((p) => p.id === placeId)?.name;
  return found ?? KEY_SCOPES.find((s) => s.id === scope)!.label;
}

export function WhereStepBody({
  scope,
  placeId,
  spaces,
  projects,
  placesFailed,
  holder,
  holders,
  onPick,
  onHolder,
}: {
  /** The scope picked so far (null: none yet). */
  scope: KeyScope | null;
  placeId: string | null;
  spaces: readonly KeyPlace[];
  projects: readonly KeyPlace[];
  placesFailed?: { readonly retry: () => void } | null;
  holder: KeyHolderChoice["id"];
  /** The holders the scope offers (`keyHoldersForScope`). */
  holders: readonly KeyHolderChoice[];
  onPick: (scope: KeyScope, placeId: string | null) => void;
  onHolder: (holder: KeyHolderChoice["id"]) => void;
}) {
  // A space or a project is picked in two moves: the card, then the place.
  const [pending, setPending] = useState<KeyScope | null>(
    scope && scope !== "pod" && !placeId ? scope : null
  );
  const shown = pending ?? scope;
  const places = shown === "space" ? spaces : projects;
  const [holderOpen, setHolderOpen] = useState(false);
  const current = holders.find((h) => h.id === holder) ?? holders[0]!;

  return (
    <div className="flex flex-col gap-3">
      <ul className="grid gap-2 sm:grid-cols-3">
        {KEY_SCOPES.map((s) => (
          <li key={s.id}>
            <ChoiceCard
              title={s.label}
              description={s.description}
              selected={shown === s.id}
              onPress={() => {
                if (s.id === "pod") {
                  setPending(null);
                  onPick("pod", null);
                } else setPending(s.id);
              }}
            />
          </li>
        ))}
      </ul>
      {shown === "space" || shown === "project" ? (
        placesFailed ? (
          <LoadFailed
            what={shown === "space" ? "Your spaces" : "Your projects"}
            retry={placesFailed.retry}
          />
        ) : places.length === 0 ? (
          <p className="text-[12px] text-foreground/65">
            {shown === "space"
              ? "There is no space on this pod yet."
              : "There is no project on this pod yet."}
          </p>
        ) : (
          <Select
            size="sm"
            className="max-w-sm"
            label={shown === "space" ? "Which space" : "Which project"}
            selectedKeys={placeId && shown === scope ? [placeId] : []}
            onSelectionChange={(keys) => {
              const id = Array.from(keys as Set<string>)[0];
              if (id) {
                setPending(null);
                onPick(shown, id);
              }
            }}
          >
            {places.map((p) => (
              <SelectItem key={p.id}>{p.name}</SelectItem>
            ))}
          </Select>
        )
      ) : null}
      {holders.length > 1 ? (
        holderOpen ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-foreground/85">
              Who holds it
            </span>
            <ul className="grid gap-2 sm:grid-cols-2">
              {holders.map((h) => (
                <li key={h.id}>
                  <ChoiceCard
                    title={h.label}
                    description={h.description}
                    selected={holder === h.id}
                    onPress={() => {
                      onHolder(h.id);
                      setHolderOpen(false);
                    }}
                  />
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="flex flex-wrap items-center gap-x-2 text-[12px] text-foreground/70">
            <span>{current.description}</span>
            <button
              type="button"
              onClick={() => setHolderOpen(true)}
              className="text-foreground/80 underline decoration-foreground/30 underline-offset-2 hover:text-foreground"
            >
              Change who holds it
            </button>
          </p>
        )
      ) : null}
    </div>
  );
}

// ─── 2. What it is for ─────────────────────────────────────────────────────

export function PurposeStepBody({
  offered,
  hidden,
  selectedId,
  somethingElse,
  rolesFailed,
  onTemplate,
  onSomethingElse,
}: {
  /** The templates that work where the key acts (`templatesForScope`). */
  offered: readonly GrantRole[];
  hidden: readonly { readonly template: GrantRole; readonly why: string }[];
  selectedId: string | null;
  /** "Something else" is the answer. */
  somethingElse: boolean;
  rolesFailed?: { readonly retry: () => void } | null;
  onTemplate: (t: GrantRole) => void;
  onSomethingElse: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <ul className="grid gap-2 sm:grid-cols-2">
        {offered.map((t) => (
          <li key={t.id}>
            <ChoiceCard
              title={t.name}
              description={t.description}
              selected={selectedId === t.id}
              danger={isFullAccess(t.grant)}
              mark={
                t.stored ? (
                  <span className="text-[11px] text-foreground/60">Yours</span>
                ) : null
              }
              onPress={() => onTemplate(t)}
            />
          </li>
        ))}
        <li>
          <ChoiceCard
            title="Something else"
            description="Start from nothing and pick what it can do."
            selected={somethingElse}
            onPress={onSomethingElse}
          />
        </li>
        <li>
          {/* A door, not a key (keys plan Decision 3): an AI gets its own limits as an agent. */}
          <Link
            href="/connect"
            className="flex h-full flex-col gap-1 rounded-lg border border-dashed border-foreground/15 px-3 py-2.5 text-left hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <span className="text-[12.5px] font-medium text-foreground">
              {KEY_AGENT_DOOR.name}
            </span>
            <span className="text-[11.5px] text-foreground/65">
              {KEY_AGENT_DOOR.description}
            </span>
          </Link>
        </li>
      </ul>
      {hidden.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {hidden.map((h) => (
            <li key={h.template.id} className="text-[12px] text-foreground/60">
              {h.why}
            </li>
          ))}
        </ul>
      ) : null}
      {rolesFailed ? (
        <LoadFailed what="Your saved templates" retry={rolesFailed.retry} />
      ) : null}
    </div>
  );
}

// ─── 4. Name it ────────────────────────────────────────────────────────────

export function NameStepBody({
  draft,
  onChange,
}: {
  draft: KeyDraft;
  onChange: (next: KeyDraft) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
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
    </div>
  );
}

// ─── The bar ───────────────────────────────────────────────────────────────

/**
 * Under every step, docked at the bottom of the column: the key in one
 * sentence, its danger marks, what still stops it (each a link to its step),
 * and the one primary. The only place New key says the whole key.
 */
export function KeyReviewBar({
  draft,
  validation,
  unanswered = [],
  kindNames,
  primaryLabel,
  onPrimary,
  busy,
  error,
}: {
  draft: KeyDraft;
  validation: KeyDraftValidation;
  /** Steps the person has not answered yet (a link to each, with its hint). */
  unanswered?: readonly KeyDraftStepId[];
  kindNames?: Readonly<Record<string, string>>;
  primaryLabel: string;
  onPrimary: () => void;
  busy: boolean;
  /** The door's refusal, in its words. */
  error?: string | null;
}) {
  const d = describeKey(draft, { kindNames });
  return (
    <section
      aria-label="The key"
      data-key-review=""
      className="sticky bottom-0 z-10 -mx-4 mt-2 flex flex-col gap-2 border-t border-foreground/[0.08] bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6"
    >
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
      {!validation.ok || unanswered.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {unanswered.map((step) => (
            <li key={step} className="text-[12px] text-foreground/75">
              <a
                href={`#${stepAnchor(step)}`}
                className="underline decoration-foreground/30 underline-offset-2 hover:text-foreground"
              >
                {STEP_LABEL[step]}
              </a>
              : {KEY_DRAFT_STEPS.find((s) => s.id === step)!.hint}
            </li>
          ))}
          {(validation.ok ? [] : validation.problems).map((p, i) => {
            const { step, text } = describeKeyProblem(p);
            return (
              <li key={i} className="text-[12px] text-foreground/75">
                <a
                  href={`#${stepAnchor(step)}`}
                  className="underline decoration-foreground/30 underline-offset-2 hover:text-foreground"
                >
                  {STEP_LABEL[step]}
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
        <Button
          color="primary"
          size="md"
          radius="md"
          isDisabled={!validation.ok || unanswered.length > 0 || busy}
          isLoading={busy}
          onPress={onPrimary}
        >
          {primaryLabel}
        </Button>
      </div>
    </section>
  );
}

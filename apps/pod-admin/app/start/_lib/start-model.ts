/**
 * The `/start` journey in pod-admin: where a request goes, and what S1 shows.
 *
 * Pure: the server pages read the pod (`onboarding.startState`,
 * `onboarding.listStarts`) and hand the answers here. The step ids and their
 * order are the ONE start model's (`@synap-core/types/onboarding/start`); this
 * file only maps them to pages and decides the S1 defaults (plan v1 §1 "The
 * gate", "Resume", S1).
 *
 * The reads go through the raw pod caller (`lib/pod-trpc.ts`), so the wire
 * shapes the pages read are declared here.
 */

import {
  START_STEP_IDS,
  type StartStepId,
  type StartValues,
} from "@synap-core/types/onboarding/start";
import { navHref } from "../../../lib/console-nav";
import type { PodCallResult } from "../../../lib/pod-trpc";
import type { ConsoleRole } from "../../../lib/route-policy";

/** One start card (`onboarding.listStarts`: the bundled templates' `meta.start`). */
export interface StartCard {
  slug: string;
  icon: string;
  order: number;
  label: string;
  promise: string;
}

/** The cloud answers, as the pod pulled them. EMPTY and FAILED are never folded. */
export type CloudState =
  | {
      status: "ok";
      answers: { start?: string; workingOn?: string };
    }
  | { status: "empty" }
  | { status: "not-linked" }
  | { status: "failed"; reason: string };

/** `onboarding.startState`, the fields pod-admin reads. */
export interface StartState {
  due: boolean;
  journey: {
    status: string;
    progress?: { values?: { start?: StartValues } };
  } | null;
  next: StartStepId | null;
  cloud: CloudState | null;
  starts?: StartCard[];
}

// ── Pages ───────────────────────────────────────────────────────────────────

/** Each step's page. The intent step IS `/start`. */
export function startStepHref(step: StartStepId): string {
  return step === "start:intent"
    ? "/start"
    : `/start/${step.slice("start:".length)}`;
}

/** "Step N of 7" — the trail every `/start` page shows. */
export function startStepNumber(step: StartStepId): {
  n: number;
  of: number;
} {
  return { n: START_STEP_IDS.indexOf(step) + 1, of: START_STEP_IDS.length };
}

/**
 * Where Home sends the person after a FAILED `startState` read: Home, with
 * the failure shown (never onboarding forced on a guess, never a calm Home
 * that hides the failure).
 */
export const START_UNAVAILABLE_HREF = navHref("home", { start: "unavailable" });

const HOME = navHref("home");

/**
 * The root gate (`/`). A non-admin is never sent to onboarding (members are
 * not onboarded in v1): the read is not even consulted. An admin goes to
 * `/start` only when the pod says it is due.
 */
export function rootDestination(input: {
  role: ConsoleRole | null;
  read: PodCallResult<StartState> | null;
}): string {
  if (input.role !== "admin" || !input.read) return HOME;
  if (!input.read.ok) return START_UNAVAILABLE_HREF;
  return input.read.data.due ? "/start" : HOME;
}

/**
 * `/start` itself: reopen the step the person is at (reload, Home's
 * "Continue setup"), unless they came BACK to the first step to change it.
 */
export function startPageDestination(input: {
  read: PodCallResult<StartState>;
  /** `?step=intent`: the Back door from a later step. */
  backToIntent: boolean;
}): { kind: "redirect"; href: string } | { kind: "render"; state: StartState } {
  const { read } = input;
  if (!read.ok) return { kind: "redirect", href: START_UNAVAILABLE_HREF };
  const { next } = read.data;
  if (next === null) return { kind: "redirect", href: HOME };
  if (next !== "start:intent" && !input.backToIntent) {
    return { kind: "redirect", href: startStepHref(next) };
  }
  return { kind: "render", state: read.data };
}

// ── S1 ──────────────────────────────────────────────────────────────────────

export interface IntentModel {
  cards: StartCard[];
  /** The card selected when the page opens, or null (no default). */
  selected: string | null;
  /** The card that carries the "From synap.live" mark. */
  fromCloud: string | null;
  /** The person's own sentence from synap.live, quoted under the cards. */
  said: string | null;
  /** The cloud read FAILED: shown as a warning, and nothing is pre-selected. */
  cloudFailed: boolean;
}

/**
 * S1's defaults. In order: a start already recorded (Back) → the cloud pick,
 * when it names a listed card → the first card (the self-hosted / empty
 * path, an Island default). A FAILED cloud read pre-selects nothing: the
 * person's synap.live answer may exist, so no card is guessed over it.
 */
export function intentModel(input: {
  starts: StartCard[];
  cloud: CloudState | null;
  recorded: StartValues["intent"] | undefined;
}): IntentModel {
  const cards = [...input.starts].sort((a, b) => a.order - b.order);
  const listed = (slug: string | undefined) =>
    slug !== undefined && cards.some((c) => c.slug === slug) ? slug : null;
  const cloud = input.cloud;
  const cloudPick = cloud?.status === "ok" ? listed(cloud.answers.start) : null;
  const said =
    cloud?.status === "ok" && cloud.answers.workingOn?.trim()
      ? cloud.answers.workingOn.trim()
      : null;
  const cloudFailed = cloud?.status === "failed";

  const recorded = listed(input.recorded?.slug);
  if (recorded) {
    return {
      cards,
      selected: recorded,
      fromCloud: input.recorded?.source === "cloud" ? recorded : null,
      said,
      cloudFailed,
    };
  }
  return {
    cards,
    selected: cloudFailed ? null : (cloudPick ?? cards[0]?.slug ?? null),
    fromCloud: cloudPick,
    said,
    cloudFailed,
  };
}

/** What Continue records: `cloud` only when the card IS the synap.live pick. */
export function intentPatch(
  slug: string,
  model: Pick<IntentModel, "fromCloud">
): { slug: string; source: "cloud" | "here" } {
  return { slug, source: slug === model.fromCloud ? "cloud" : "here" };
}

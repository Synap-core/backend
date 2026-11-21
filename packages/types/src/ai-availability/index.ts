/**
 * @synap-core/types/ai-availability — THE one model of "can AI run for me
 * right now, and if not, who does what". Browser, synap-app and relay all
 * render this; none of them re-derives a state, a CTA or a sentence.
 *
 * Three inputs, one answer, worst first:
 *   - `billing` — the Control Plane's pod billing block (`PodBillingStatus`,
 *     `@synap-core/control-plane-types`). The CP is the SSOT for credits: its
 *     state, threshold, dismiss key and viewer action pass through untouched.
 *   - `failureCode` — a refusal on the wire (the pod's `AiFailureCode` on a
 *     chat stream error, or the IS's `IsFailureEnvelope.code`).
 *   - `health` — the intelligence service health verdict.
 *
 * `billing` is typed STRUCTURALLY ({@link AiBillingInput}) rather than by
 * importing `PodBillingStatus`: that type lives in another repo
 * (`synap-app/packages/headless/src/control-plane-types`) and this package must stay
 * dependency-free. A caller passes its `PodBillingStatus` straight in; if the
 * CP shape ever drifts away from these fields, that call stops compiling.
 *
 * Pure and dependency-free (sibling leaves only).
 */
import type {
  IsFailureAction,
  IsFailureActor,
  IsFailureEnvelope,
} from "../hub-protocol/index.js";
import { resolveActionLabel, resolveStatusLabel } from "../vocabulary/index.js";
import type { LensBannerInput } from "../lens/header.js";

// ── Vocabularies ────────────────────────────────────────────────────────────

export const AI_AVAILABILITY_KINDS = [
  "ok",
  "credits_low",
  "credits_empty",
  "not_entitled",
  "suspended",
  "budget_paused",
  "provider_issue",
  "service_down",
] as const;
export type AiAvailabilityKind = (typeof AI_AVAILABILITY_KINDS)[number];

/** WHO must act — the IS / CP vocabulary. `null` on the result = nobody. */
export type AiActor = IsFailureActor;
/** WHAT the viewer does — the CP's `PodBillingAction` vocabulary. */
export type AiAction = IsFailureAction;
/** The viewer, for CTA purposes: can they pay, or must they ask? */
export type AiViewerRole = "payer" | "member";

export type AiAvailabilityTone = "error" | "warning" | "info";
/** An abstract mark; each platform maps it to its own icon. */
export type AiAvailabilityGlyph =
  "gauge" | "gauge-empty" | "lock" | "pause" | "wrench";

/**
 * How long a dismiss holds (founder: every notice is dismissible, except the
 * composer hint while blocked):
 *   - `threshold` — until the next low-credit threshold is crossed (the key
 *     carries the threshold, so a new crossing is a new key).
 *   - `session` — for this app session; it returns on the next launch.
 *   - `condition` — until the condition key changes (operator states).
 */
export type AiDismissScope = "threshold" | "session" | "condition";

/**
 * The POD's wire code on a chat stream error (`CHAT_STREAM_ERROR.code`). SSOT:
 * `packages/api/src/utils/ai-failure.ts` re-exports this type.
 */
export const AI_FAILURE_CODES = [
  "provider_no_credit",
  "quota_exhausted",
  "account_quota_exceeded",
  "not_entitled",
  "credits_empty",
  "access_suspended",
  "account_inactive",
  "llm_budget_exceeded",
  "context_length_exceeded",
  "content_filter",
  "cancelled",
  "provider_auth",
  "rate_limited",
  "timeout",
  "circuit_open",
  "entitlement_unavailable",
  "upstream_error",
  "bad_request",
  "invalid_response",
  "unknown",
] as const;
export type AiFailureCode = (typeof AI_FAILURE_CODES)[number];

/** The literal members of an open union (`"a" | "b" | (string & {})` → `"a" | "b"`). */
type LiteralsOf<T> = T extends string ? (string extends T ? never : T) : never;

/** The IS's named codes on `IsFailureEnvelope.code` (its open tail excluded). */
// `Exclude<…, undefined>`, not `NonNullable`: `NonNullable` intersects with `{}`,
// which collapses `string & {}` to `string` and swallows every literal.
export type IsFailureCode = LiteralsOf<
  Exclude<IsFailureEnvelope["code"], undefined>
>;

/** Every code {@link resolveAiFailureState} classifies. */
export type AiRefusalCode = AiFailureCode | IsFailureCode;

/**
 * THE classification. A mapped type over {@link AiRefusalCode}: a code added
 * to either union without a row here (or a row for a code that no longer
 * exists) FAILS THE BUILD. `null` = a transient, per-turn fault (rate limit,
 * timeout, prompt too long, cancelled…) — it stays on the failed turn with its
 * Retry and is never an availability state.
 *
 * Choices worth naming (overridable):
 *   - `account_inactive` → `not_entitled`: AI is switched off for the
 *     account and the payer turns it back on; "Payment needed" would lie.
 *   - `quota_exhausted` (the PROVIDER's quota) → `budget_paused`: an operator
 *     capacity state that frees on a reset, as the UX contract tables it.
 *   - `upstream_error` / `provider_error` → transient: one 5xx is not "AI is
 *     offline". `circuit_open` IS — the breaker opened on repeated failures.
 *   - `entitlement_unavailable` → transient: the IS could not read the
 *     account's entitlement from the Control Plane this once; a retry may pass.
 */
const FAILURE_STATE: {
  readonly [C in AiRefusalCode]: AiAvailabilityKind | null;
} = {
  // pod codes
  provider_no_credit: "provider_issue",
  quota_exhausted: "budget_paused",
  account_quota_exceeded: "credits_empty",
  not_entitled: "not_entitled",
  credits_empty: "credits_empty",
  access_suspended: "suspended",
  account_inactive: "not_entitled",
  llm_budget_exceeded: "budget_paused",
  context_length_exceeded: null,
  content_filter: null,
  cancelled: null,
  provider_auth: "provider_issue",
  rate_limited: null,
  timeout: null,
  circuit_open: "service_down",
  entitlement_unavailable: null,
  upstream_error: null,
  bad_request: null,
  invalid_response: null,
  unknown: null,
  // IS-only codes
  insufficient_credit: "provider_issue",
  auth: "provider_issue",
  rate_limit: null,
  provider_error: null,
};

/**
 * A refusal code → the availability state it proves, or `null` for a
 * transient fault and for any code nobody classified (an open-union tail from
 * a newer IS): never guess a state from an unknown token.
 */
export function resolveAiFailureState(
  code: string | null | undefined
): AiAvailabilityKind | null {
  if (!code) return null;
  return Object.prototype.hasOwnProperty.call(FAILURE_STATE, code)
    ? FAILURE_STATE[code as AiRefusalCode]
    : null;
}

// ── The per-state table (data, one place) ───────────────────────────────────

interface KindSpec {
  /** Worst first: lower = worse. */
  rank: number;
  tone: AiAvailabilityTone | null;
  glyph: AiAvailabilityGlyph | null;
  actor: AiActor | null;
  dismiss: AiDismissScope | null;
  /** Chat and agents are refused; the composer shows its hint. Capture still saves. */
  blocksComposer: boolean;
}

const KIND: { readonly [K in AiAvailabilityKind]: KindSpec } = {
  suspended: {
    rank: 0,
    tone: "error",
    glyph: "lock",
    actor: "payer",
    dismiss: "session",
    blocksComposer: true,
  },
  not_entitled: {
    rank: 1,
    tone: "error",
    glyph: "lock",
    actor: "payer",
    dismiss: "session",
    blocksComposer: true,
  },
  credits_empty: {
    rank: 2,
    tone: "error",
    glyph: "gauge-empty",
    actor: "payer",
    dismiss: "session",
    blocksComposer: true,
  },
  budget_paused: {
    rank: 3,
    tone: "info",
    glyph: "pause",
    actor: "operator",
    dismiss: "condition",
    blocksComposer: true,
  },
  service_down: {
    rank: 4,
    tone: "info",
    glyph: "wrench",
    actor: "operator",
    dismiss: "condition",
    blocksComposer: false,
  },
  provider_issue: {
    rank: 5,
    tone: "info",
    glyph: "wrench",
    actor: "operator",
    dismiss: "condition",
    blocksComposer: false,
  },
  credits_low: {
    rank: 6,
    tone: "warning",
    glyph: "gauge",
    actor: "payer",
    dismiss: "threshold",
    blocksComposer: false,
  },
  ok: {
    rank: 7,
    tone: null,
    glyph: null,
    actor: null,
    dismiss: null,
    blocksComposer: false,
  },
};

/** Precedence, worst first — derived from the table, never a second list. */
export const AI_AVAILABILITY_PRECEDENCE: readonly AiAvailabilityKind[] = [
  ...AI_AVAILABILITY_KINDS,
].sort((a, b) => KIND[a].rank - KIND[b].rank);

// ── Inputs ──────────────────────────────────────────────────────────────────

/**
 * The fields of the CP's `PodBillingStatus` this model reads. Structural on
 * purpose (see the module doc); a `PodBillingStatus` is assignable to it.
 */
export type AiBillingInput =
  | {
      readFailed: false;
      state:
        "ok" | "low" | "empty" | "not_entitled" | "suspended" | "unmetered";
      threshold: number | null;
      dismissKey: string | null;
      resetsAt: string | null;
      viewerRole: "pod_owner" | "owner" | "admin" | "member";
      canTopUp: boolean;
      action: AiAction;
    }
  | { readFailed: true };

/** The IS health verdict (`intelligence_services` health check). */
export type AiHealthInput =
  "ok" | "healthy" | "degraded" | "unhealthy" | "unreachable";

export interface AiAvailabilityInput {
  /**
   * The CP billing block. Omit ONLY on a surface that does not read billing;
   * a read in flight or failed is not "omitted" — pass the failure through.
   */
  billing?: AiBillingInput | null;
  /** A refusal code from the wire (pod `AiFailureCode` or IS envelope code). */
  failureCode?: string | null;
  /** The action the IS resolved for this caller on that refusal. */
  failureAction?: AiAction | null;
  health?: AiHealthInput | null;
  /**
   * Payer vs member. Defaults from `billing.viewerRole` (owner, admin and the
   * pod's own user pay — founder decision), else `payer`.
   */
  role?: AiViewerRole | null;
  /** Can this viewer buy a pack now? Defaults from `billing.canTopUp`. */
  canTopUp?: boolean | null;
  /** When an operator state frees (budget reset). */
  resetsAt?: string | null;
}

// ── Output ──────────────────────────────────────────────────────────────────

export interface AiAvailability {
  /**
   * The state. `null` ONLY when the billing read FAILED and nothing else
   * proves a state: unmeasured, never "ok". Render a failed-read affordance.
   */
  kind: AiAvailabilityKind | null;
  /** The CP billing read failed (may be true beside a wire-proven `kind`). */
  readFailed: boolean;
  actor: AiActor | null;
  /** The ONE CTA for this viewer; `none` for operator states and `ok`. */
  action: AiAction;
  tone: AiAvailabilityTone | null;
  glyph: AiAvailabilityGlyph | null;
  /** The crossed low-credit threshold (20 / 10 / 5), `credits_low` only. */
  thresholdPct?: number;
  /**
   * `not_entitled` only: AI is switched off for the account
   * (`account_inactive` on the wire) rather than missing from the plan. The
   * deck says "AI is turned off", never "Your plan has no AI". Present only
   * when the wire alone proved it: a CP read of the same state wins, since
   * the CP is the SSOT for the plan.
   */
  switchedOff?: true;
  resetsAt?: string;
  /** Store this on dismiss; a stored key that no longer matches re-surfaces. */
  dismissKey: string | null;
  dismissScope: AiDismissScope | null;
  blocksComposer: boolean;
  /** Where this state shows. */
  surfaces: {
    /** Glyph + tone on the composer / capture `+` / shell AI chip. */
    ambient: boolean;
    /** The ONE lens status banner (dismissible). */
    banner: boolean;
    /** The line above a blocked composer — NOT dismissible. */
    composerHint: boolean;
  };
}

const BILLING_KIND: Record<
  Extract<AiBillingInput, { readFailed: false }>["state"],
  AiAvailabilityKind
> = {
  ok: "ok",
  unmetered: "ok",
  low: "credits_low",
  empty: "credits_empty",
  not_entitled: "not_entitled",
  suspended: "suspended",
};

function healthKind(
  h: AiHealthInput | null | undefined
): AiAvailabilityKind | null {
  if (h === "unhealthy" || h === "unreachable") return "service_down";
  if (h === "degraded") return "provider_issue";
  return null;
}

function worst(
  kinds: readonly (AiAvailabilityKind | null)[]
): AiAvailabilityKind | null {
  let out: AiAvailabilityKind | null = null;
  for (const k of kinds) {
    if (k && (out === null || KIND[k].rank < KIND[out].rank)) out = k;
  }
  return out;
}

/**
 * Payer vs member, from the CP billing block: owner, admin and the pod's own
 * user pay (founder decision); only `member` does not. A missing or failed
 * read defaults to `payer`. The ONE reading of the CP's billing role, so no
 * surface compares role tokens itself. It matters even where `action` is
 * `none` (an `ok` or operator state), for example whether to offer Reprovision.
 */
export function resolveAiViewerRole(
  billing: AiBillingInput | null | undefined
): AiViewerRole {
  return billing &&
    billing.readFailed === false &&
    billing.viewerRole === "member"
    ? "member"
    : "payer";
}

/**
 * Resolve the viewer's AI availability. Worst first across billing, the wire
 * refusal and health ({@link AI_AVAILABILITY_PRECEDENCE}).
 *
 * The CTA: an operator state has none. A payer state takes the CP's `action`
 * when the CP proved that same state (the SSOT, resolved for this viewer);
 * else the IS's `failureAction`; else member → `ask_admin`, payer →
 * `top_up` when they can buy a pack, otherwise `upgrade` (`fix_payment` for
 * `suspended`).
 */
export function resolveAiAvailability(
  input: AiAvailabilityInput
): AiAvailability {
  const billing = input.billing ?? null;
  const cp = billing && billing.readFailed === false ? billing : null;
  const readFailed = billing?.readFailed === true;

  const billingKind = cp ? BILLING_KIND[cp.state] : null;
  const failureKind = resolveAiFailureState(input.failureCode);
  const kind =
    worst([billingKind, failureKind, healthKind(input.health)]) ??
    (readFailed ? null : "ok");

  const role: AiViewerRole = input.role ?? resolveAiViewerRole(cp);
  const canTopUp = input.canTopUp ?? cp?.canTopUp ?? false;

  if (kind === null) {
    return {
      kind: null,
      readFailed: true,
      actor: null,
      action: "none",
      tone: null,
      glyph: null,
      dismissKey: null,
      dismissScope: null,
      blocksComposer: false,
      surfaces: { ambient: false, banner: false, composerHint: false },
    };
  }

  const spec = KIND[kind];
  const fromCp = cp !== null && billingKind === kind;

  let action: AiAction = "none";
  if (spec.actor === "payer") {
    if (fromCp && cp.action !== "none") action = cp.action;
    else if (
      input.failureAction &&
      input.failureAction !== "none" &&
      failureKind === kind
    )
      action = input.failureAction;
    else if (role === "member") action = "ask_admin";
    else if (kind === "suspended") action = "fix_payment";
    else action = canTopUp ? "top_up" : "upgrade";
  }

  const switchedOff =
    kind === "not_entitled" &&
    !fromCp &&
    failureKind === kind &&
    input.failureCode === "account_inactive";

  const thresholdPct =
    kind === "credits_low" && fromCp && cp.threshold != null
      ? cp.threshold
      : undefined;
  const resetsAt = (fromCp ? cp.resetsAt : null) ?? input.resetsAt ?? undefined;

  // The dismiss key. Our own prefix carries what the RULE keys on (the
  // threshold, the operator condition), and the CP's key rides along so a CP
  // re-key (period reset) also re-surfaces.
  let dismissKey: string | null = null;
  if (kind !== "ok") {
    const cpKey = fromCp && cp.dismissKey ? `|${cp.dismissKey}` : "";
    if (spec.dismiss === "threshold")
      dismissKey = `ai:credits_low:${thresholdPct ?? "?"}${cpKey}`;
    else if (spec.dismiss === "session") dismissKey = `ai:${kind}${cpKey}`;
    else {
      const condition =
        failureKind === kind
          ? (input.failureCode ?? "")
          : healthKind(input.health) === kind
            ? `health:${input.health}`
            : "";
      dismissKey = `ai:${kind}:${condition}:${resetsAt ?? ""}`;
    }
  }

  return {
    kind,
    readFailed,
    actor: spec.actor,
    action,
    tone: spec.tone,
    glyph: spec.glyph,
    ...(thresholdPct !== undefined ? { thresholdPct } : {}),
    ...(switchedOff ? { switchedOff: true as const } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    dismissKey,
    dismissScope: spec.dismiss,
    blocksComposer: spec.blocksComposer,
    surfaces: {
      ambient: kind !== "ok",
      banner: kind !== "ok",
      composerHint: spec.blocksComposer,
    },
  };
}

// ── One refusal, no billing read ────────────────────────────────────────────

/**
 * The availability ONE refusal proves, for a surface that holds the refusal
 * and nothing else: a chat error, an agent's tool reply, a bot message. It
 * reads no billing, so it never guesses a CTA the way
 * {@link resolveAiAvailability} defaults one for a viewer it knows: the
 * action is the one the IS stated for this caller, `none` when it stated
 * none, and an operator state never carries one. `null` for a transient or
 * unclassified code: that is a fact about the request, not about
 * availability.
 */
export function resolveAiRefusal(
  code: string | null | undefined,
  statedAction?: AiAction | null
): Pick<AiAvailability, "kind" | "actor" | "action" | "switchedOff"> | null {
  const kind = resolveAiFailureState(code);
  if (kind === null) return null;
  const { actor } = KIND[kind];
  return {
    kind,
    actor,
    action: actor === "payer" && statedAction ? statedAction : "none",
    ...(kind === "not_entitled" && code === "account_inactive"
      ? { switchedOff: true as const }
      : {}),
  };
}

// ── The copy deck (the ONLY table — UIs never add their own) ────────────────

export interface AiAvailabilityCopyOptions {
  /** A preformatted reset date ("Oct 31") — value formatting is the caller's. */
  resetsLabel?: string | null;
  /** The pod's name, for the member's prefilled ask. */
  podName?: string | null;
}

export interface AiAvailabilityCopy {
  /** The short state chip — `resolveStatusLabel(kind)`. */
  label: string;
  /** The banner / inline headline: the state, mark-first. */
  title: string;
  /** The CTA in the imperative mood, or null when there is none. */
  cta: string | null;
  /** The line above a blocked composer (render the CTA beside it). */
  composerHint: string | null;
  /** The prefilled message an `ask_admin` CTA shares. */
  askAdminMessage: string | null;
  /**
   * The state in full sentences, for a surface with no button (an agent's
   * tool reply, a chat error, a bot message): what stops, what still works,
   * then the viewer's action in words when there is one. It states no
   * billing rule: a reset date appears only when it arrived as data.
   */
  detail: string;
}

/** What a member asks the pod's owner to do, per payer state. */
const ASK_OWNER_TO: Partial<Record<AiAvailabilityKind, string>> = {
  credits_low: "top up credits",
  credits_empty: "top up credits",
  not_entitled: "renew the plan",
  suspended: "fix the payment",
};

/** The action in words, for the {@link AiAvailabilityCopy.detail} line. */
function actionLine(
  kind: Exclude<AiAvailabilityKind, "ok">,
  action: AiAction,
  switchedOff: boolean
): string | null {
  switch (action) {
    case "top_up":
      return "Top up credits to continue.";
    case "upgrade":
      return "Upgrade or renew the plan to continue.";
    case "fix_payment":
      return "Update the payment method to continue.";
    case "ask_admin": {
      const what = switchedOff ? "turn AI back on" : ASK_OWNER_TO[kind];
      return what ? `Ask the pod's owner to ${what}.` : null;
    }
    case "none":
      return null;
  }
}

/**
 * The words for an availability. Titles are the same for payer and member;
 * the role changes only the CTA (`ask_admin` vs a pay verb), the ask and the
 * action sentence closing `detail`.
 */
export function aiAvailabilityCopy(
  a: Pick<AiAvailability, "kind" | "action" | "thresholdPct" | "switchedOff">,
  options: AiAvailabilityCopyOptions = {}
): AiAvailabilityCopy | null {
  if (a.kind === null || a.kind === "ok") return null;
  const resets = options.resetsLabel?.trim() || null;
  const pod = options.podName?.trim() || "this pod";
  const cta =
    a.action === "none" ? null : resolveActionLabel(a.action, "imperative");
  const ask = (what: string) => (a.action === "ask_admin" ? what : null);
  const switchedOff = a.kind === "not_entitled" && a.switchedOff === true;

  const deck: Record<
    Exclude<AiAvailabilityKind, "ok">,
    {
      title: string;
      composerHint: string | null;
      askAdminMessage: string | null;
      /** `detail` before its action sentence. */
      state: string;
    }
  > = {
    credits_low: {
      title:
        a.thresholdPct != null
          ? `${a.thresholdPct}% credits left`
          : "Credits running low",
      composerHint: null,
      askAdminMessage: ask(
        `Our AI credits are running low — could you top up ${pod}?`
      ),
      state:
        (a.thresholdPct != null
          ? `${a.thresholdPct}% of this pod's AI credits are left.`
          : "This pod's AI credits are running low.") +
        (resets ? ` They reset on ${resets}.` : ""),
    },
    credits_empty: {
      title: "No AI credits left",
      composerHint: "Out of credits",
      askAdminMessage: ask(`Our AI credits are out — could you top up ${pod}?`),
      state:
        "This pod is out of AI credits, so chat and agents are paused. Captures still save." +
        (resets ? ` Credits reset on ${resets}.` : ""),
    },
    not_entitled: switchedOff
      ? {
          title: "AI is turned off",
          composerHint: "AI is off",
          askAdminMessage: ask(
            `AI is turned off for ${pod} — could you turn it back on?`
          ),
          state:
            "AI is turned off for this pod, so chat and agents are off. Captures still save.",
        }
      : {
          title: "Your plan has no AI",
          composerHint: "AI is off",
          askAdminMessage: ask(
            `Our plan has no AI — could you renew it for ${pod}?`
          ),
          state:
            "This pod's plan does not include AI, so chat and agents are off. Captures still save.",
        },
    suspended: {
      title: "Payment needed",
      composerHint: "Payment needed",
      askAdminMessage: ask(
        `AI is paused on a failed payment — could you fix it for ${pod}?`
      ),
      state: "AI is paused because a payment failed. Captures still save.",
    },
    // Operator states: nobody on the pod acts, so the words say so and offer
    // no step. The reset date is the one fact that may arrive with them.
    budget_paused: {
      title: resets ? `AI paused · resets on ${resets}` : "AI paused",
      composerHint: resets ? `AI paused · resets on ${resets}` : "AI paused",
      askAdminMessage: null,
      state:
        "AI is paused for now, and nobody on this pod needs to act. Captures still save." +
        (resets ? ` It resets on ${resets}.` : ""),
    },
    provider_issue: {
      title: "AI is having trouble",
      composerHint: null,
      askAdminMessage: null,
      state:
        "The AI provider is having trouble, so AI may not answer. Nobody on this pod needs to act. Captures still save.",
    },
    service_down: {
      title: "AI is offline",
      composerHint: null,
      askAdminMessage: null,
      state:
        "AI is offline for now, so it may not answer. Nobody on this pod needs to act. Captures still save.",
    },
  };

  const { state, ...words } = deck[a.kind];
  const then = actionLine(a.kind, a.action, switchedOff);
  return {
    label: resolveStatusLabel(switchedOff ? "account_inactive" : a.kind),
    cta,
    ...words,
    detail: then ? `${state} ${then}` : state,
  };
}

// ── Into the ONE lens status banner ─────────────────────────────────────────

/**
 * The availability as a `lensStatusBanner` input, so it folds with the page's
 * other health conditions (worst tone leads). `null` when it is not a banner
 * state (`ok`, or an unmeasured read — render that as a failed read instead).
 * Operator states carry no `action`.
 */
export function aiAvailabilityBanner(
  a: AiAvailability,
  options: AiAvailabilityCopyOptions = {}
): LensBannerInput | null {
  if (!a.surfaces.banner || a.kind === null || a.tone === null) return null;
  const copy = aiAvailabilityCopy(a, options);
  if (!copy) return null;
  return {
    key: a.dismissKey ?? `ai:${a.kind}`,
    tone: a.tone,
    title: copy.title,
    action: copy.cta ? { kind: a.action, label: copy.cta } : null,
  };
}

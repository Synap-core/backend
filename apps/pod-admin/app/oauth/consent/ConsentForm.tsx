"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@synap-core/api-types";
import { ReceiverShell } from "../../_lib/receiver-shell";
import { HostName } from "../../_lib/host-name";
import {
  Button,
  CardBody,
  CardHeader,
  Checkbox,
  Chip,
  Radio,
  RadioGroup,
  Spinner,
} from "@heroui/react";
import {
  Check,
  ChevronRight,
  Monitor,
  Plug,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  X,
} from "lucide-react";

import Link from "next/link";
import { FIRST_PARTY_CLIENT_NAMES } from "@synap-core/types/vocabulary";
import { SIGNED_IN_APPS_COPY } from "@synap-core/types/sign-in";
import { formatRelative } from "../../../lib/format";
import { trpc } from "../../../lib/trpc";
import {
  actsAsHeadline,
  allowBlockedReason,
  alsoSeeLine,
  consentWidth,
  decideLine,
  groupByObject,
  holdsSpace,
  initialSelection,
  invalidRequestHint,
  isTicked,
  LEVEL_WORDS,
  levelControlLabel,
  objectLevel,
  objectSpaceLabel,
  objectSpaces,
  otherSpaces,
  permissionLabel,
  podWideNote,
  readsSpaceRecords,
  reasonOf,
  scopeLabel,
  SPACE_REACH_NOTE,
  sectionCheckboxLabel,
  sectionState,
  setObjectLevel,
  shownSpaces,
  spaceCheckboxLabel,
  spaceHintFirst,
  splitOffer,
  toApproved,
  toggle,
  toggleObjectSpace,
  toggleSection,
  withoutSpace,
  type AccessLevel,
  type ConsentObject,
  type OfferedPermission,
  type Selection,
} from "./consent-model";

/**
 * Plain-language descriptions for the pod-grammar scopes this AS grants.
 *
 * A consent screen that shows raw scope tokens is not consent — the human has
 * to be able to tell what they are agreeing to. Unknown scopes fall back to the
 * token itself rather than being hidden, so an unlabeled scope is visible rather
 * than silently approved.
 */
const SCOPE_DESCRIPTIONS: Record<string, string> = {
  "mcp.read": "Read your entities, documents, and relations",
  "mcp.write":
    "Create and update things in your pod — every write still goes through your workspace's AI governance as a proposal you review",
};

export interface ConsentParams {
  clientId: string;
  redirectUri: string;
  responseType?: string;
  scope?: string;
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  /** RFC 8707 — round-tripped so the code is bound to it (re-validated server-side). */
  resource?: string;
  /** OIDC step-up: a fresh sign-in is required first (enforced server-side). */
  maxAge?: string;
  prompt?: string;
  /** /authorize's signed request time (`auth_req`), round-tripped. */
  authRequest?: string;
}

/**
 * Sign in again, then come back to this same request. `refresh=1` makes the
 * login page re-authenticate a signed-in person (a step-up), and the server
 * re-checks the new sign-in's time when the person decides.
 */
function signInAgain(): void {
  const here = window.location.pathname + window.location.search;
  window.location.href = `/login?refresh=1&return=${encodeURIComponent(here)}`;
}

/** The decision was refused because the sign-in is too old for this request. */
function isLoginRequired(err: unknown): boolean {
  return (
    (err as { data?: { reasonCode?: unknown } } | null)?.data?.reasonCode ===
    "LOGIN_REQUIRED"
  );
}

/** A "Confirm it's you" answered with Synap Cloud only: a pod credential is needed. */
function isPodCredentialRequired(err: unknown): boolean {
  return (
    (err as { data?: { reasonCode?: unknown } } | null)?.data?.reasonCode ===
    "POD_CREDENTIAL_REQUIRED"
  );
}

/** Sign in again with a credential at this pod only, then come back here. */
function signInWithPodCredential(): void {
  const here = window.location.pathname + window.location.search;
  window.location.href = `/login?refresh=1&credential=pod&return=${encodeURIComponent(here)}`;
}

/** Who to start again from when the request itself is not valid. */
function requesterName(clientId: string): string {
  return FIRST_PARTY_CLIENT_NAMES[clientId] ?? "the app that sent you here";
}

export type Step =
  | { kind: "idle" }
  | { kind: "working"; approve: boolean }
  | { kind: "denied" }
  | { kind: "error"; message: string }
  /** Sent to sign in again (`prompt=login` / `max_age`); nothing to decide. */
  | { kind: "reconfirming" }
  /** A Synap Cloud sign-in cannot confirm this; a pod credential is needed. */
  | { kind: "pod_credential" };

export function ConsentForm({
  params,
  podHost,
  identity,
  spaceHint,
}: {
  params: ConsentParams;
  podHost?: string;
  identity?: string;
  /**
   * The launch's `space_hint`: that space is listed first where the person
   * can give it. Kept OUT of `params`, so it never reaches the server.
   */
  spaceHint?: string;
}) {
  const [step, setStep] = useState<Step>({ kind: "idle" });

  // Resolves the client server-side. Never retried on failure: an unknown
  // client or an unregistered redirect_uri is a permanent condition, and
  // hammering it just repeats the same rejection.
  const context = trpc.apiKeys.getOAuthConsentContext.useQuery(params, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  const decide = trpc.apiKeys.decideOAuthAuthorization.useMutation();

  // `prompt=login` / `max_age` and the current sign-in is too old: sign in
  // again before anything is shown to decide on.
  const reauthenticate = context.data?.reauthenticate ?? false;
  useEffect(() => {
    if (reauthenticate) signInAgain();
  }, [reauthenticate]);
  const reconfirming = reauthenticate || step.kind === "reconfirming";
  // Re-confirmed with Synap Cloud only: ask for the pod password or passkey.
  const podCredential =
    !reconfirming &&
    (context.data?.podCredentialRequired === true ||
      step.kind === "pod_credential");

  // A pod app (CIMD client): the person narrows what it may touch, per space.
  const offered = context.data?.app ?? null;
  const app = useMemo(
    () =>
      offered
        ? {
            ...offered,
            permissions: spaceHintFirst(offered.permissions, spaceHint),
          }
        : null,
    [offered, spaceHint]
  );
  const [selection, setSelection] = useState<Selection>(new Set());
  const [customize, setCustomize] = useState(false);
  useEffect(() => {
    if (app) {
      setSelection(
        initialSelection(app.permissions, app.approved, app.templates)
      );
    }
  }, [app]);
  const approved = app ? toApproved(selection, app.permissions) : [];

  const act = useCallback(
    (approve: boolean) => {
      setStep({ kind: "working", approve });
      decide.mutate(
        {
          ...params,
          approve,
          ...(app ? { approved } : {}),
          // An app sign-in is approved for exactly what this screen showed.
          appSignInFingerprint: context.data?.appSignIn?.fingerprint,
        },
        {
          onSuccess: ({ redirectTo }) => {
            // Built server-side from the client's REGISTERED redirect_uri, so
            // this is never an attacker-chosen destination. Top-level navigate
            // (not router.push) — the target is off-origin.
            window.location.href = redirectTo;
          },
          onError: (err) => {
            if (isLoginRequired(err)) {
              setStep({ kind: "reconfirming" });
              signInAgain();
              return;
            }
            if (isPodCredentialRequired(err)) {
              setStep({ kind: "pod_credential" });
              return;
            }
            if (!approve) {
              // Deny should never strand the user on an error screen; the
              // authorization simply did not happen.
              setStep({ kind: "denied" });
              return;
            }
            setStep({ kind: "error", message: err.message });
          },
        }
      );
    },
    [decide, params, app, approved, context.data]
  );

  const busy = step.kind === "working";
  // "Sign in with Synap": every sentence below comes from the server, derived
  // from the grant the person would receive — never written here.
  const appSignIn = context.data?.appSignIn ?? null;
  // A Synap app (desktop, Relay) signing the person in on this device. Its
  // name comes from the server (the vocabulary door); a loopback redirect is
  // this computer, anything else the app's own link on a phone.
  const firstParty =
    context.data?.clientKind === "first_party"
      ? {
          name: context.data.clientName,
          onComputer: isLoopbackHost(context.data.redirectHost),
          redirectHost: context.data.redirectHost,
          // The app re-confirms a device it holds (a step-up). The server
          // decides, and binds the code to it: it can never make a device.
          reconfirm: context.data.reconfirmDevice,
        }
      : null;

  return (
    <ReceiverShell
      podHost={podHost}
      identity={identity}
      width={consentWidth(params.clientId)}
    >
      <CardHeader className="flex flex-col items-start gap-3 px-7 pt-7 pb-0">
        <span
          aria-hidden
          className="
              flex h-11 w-11 items-center justify-center
              rounded-lg
              bg-primary/10 ring-1 ring-inset ring-primary/20
              text-primary
            "
        >
          <Plug className="h-5 w-5" strokeWidth={2} />
        </span>
        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold uppercase tracking-[0.06em] text-foreground/65">
            {firstParty ? "Sign-in request" : "Connection request"}
          </p>
          {firstParty ? (
            <>
              <h1 className="font-heading text-xl font-medium leading-tight tracking-tight text-foreground">
                {firstParty.reconfirm
                  ? "Confirm it's you"
                  : `Sign in to ${firstParty.name}`}
              </h1>
              <p className="text-sm leading-relaxed text-foreground/65">
                {firstParty.onComputer ? "On this computer" : "On your phone"}
                {podHost ? `, to ${podHost}` : ""}
                {identity ? ` as ${identity}` : ""}.
              </p>
            </>
          ) : app ? (
            <>
              {/* A pod app's identity is its DOMAIN (the client_id host), not
                  the name it gives itself. */}
              <Chip
                size="sm"
                variant="flat"
                color={app.verified ? "primary" : "warning"}
                startContent={
                  app.verified ? (
                    <ShieldCheck className="h-3 w-3" aria-hidden />
                  ) : (
                    <ShieldAlert className="h-3 w-3" aria-hidden />
                  )
                }
              >
                {app.verified ? "Synap app" : "Unverified app"}
              </Chip>
              <h1 className="text-xl font-medium leading-tight text-foreground">
                <HostName host={app.domain} />
              </h1>
              <p className="text-sm leading-relaxed text-foreground/65">
                {/* Self-chosen display text, rendered as text only. */}
                Calls itself &ldquo;{context.data?.clientName}&rdquo; and wants
                to connect to your pod{podHost ? ` ${podHost}` : ""}
                {identity ? ` as ${identity}` : ""}.
              </p>
              {/* A Synap app acts AS the person: said plainly, from the
                  server's words and the spaces ticked below (the grant). */}
              {app.actsAs.kind === "person" ? (
                <p className="text-[13px] font-medium leading-relaxed text-foreground/90">
                  {actsAsHeadline(app.actsAs.lead, selection, app.permissions)}
                </p>
              ) : null}
            </>
          ) : (
            <>
              <h1 className="font-heading text-xl font-medium leading-tight tracking-tight text-foreground">
                {/* Registered by an unauthenticated DCR call — attacker-choosable
                      display text. React escapes it; it is NEVER rendered as markup.
                      An app sign-in's name is its owner's app name on this pod. */}
                {appSignIn ? "Sign in to" : "Connect"}{" "}
                {context.data?.clientName ?? "an application"}
              </h1>
              <p className="text-sm leading-relaxed text-foreground/65">
                {appSignIn
                  ? appSignIn.headline
                  : "It is asking to connect to your Synap pod."}
              </p>
            </>
          )}
        </div>
      </CardHeader>

      <CardBody className="flex flex-col gap-5 px-7 pb-7 pt-5">
        {reconfirming ? (
          <ReconfirmingNotice />
        ) : podCredential ? (
          <PodCredentialNotice
            name={context.data?.clientName ?? requesterName(params.clientId)}
            onContinue={signInWithPodCredential}
          />
        ) : (
          <>
            {context.isLoading && (
              <div className="flex items-center justify-center py-10">
                <Spinner size="sm" />
              </div>
            )}

            {context.isError && (
              <Problem
                title="This authorization request isn't valid"
                message={context.error.message}
                hint={invalidRequestHint(params.clientId)}
              />
            )}

            {context.data &&
              app &&
              step.kind !== "denied" &&
              step.kind !== "error" && (
                <AppConsent
                  app={app}
                  registeredAt={context.data.registeredAt}
                  redirectHost={context.data.redirectHost}
                  selection={selection}
                  onToggle={(permission, workspaceId) =>
                    setSelection((s) =>
                      toggle(s, app.permissions, permission, workspaceId)
                    )
                  }
                  onToggleSection={(section) =>
                    setSelection((s) =>
                      toggleSection(s, app.permissions, section)
                    )
                  }
                  onSetLevel={(row, level) =>
                    setSelection((s) =>
                      setObjectLevel(
                        s,
                        app.permissions,
                        row,
                        level,
                        app.templates
                      )
                    )
                  }
                  onToggleObjectSpace={(row, workspaceId) =>
                    setSelection((s) =>
                      toggleObjectSpace(s, app.permissions, row, workspaceId)
                    )
                  }
                  customize={customize}
                  onCustomize={setCustomize}
                  onSpaceCreated={() => void context.refetch()}
                  busy={busy}
                  step={step}
                  blockedReason={allowBlockedReason(app.permissions, selection)}
                  onDecide={act}
                />
              )}

            {context.data &&
              firstParty &&
              step.kind !== "denied" &&
              step.kind !== "error" && (
                <FirstPartyConsent
                  {...firstParty}
                  busy={busy}
                  step={step}
                  onDecide={act}
                />
              )}

            {context.data &&
              !app &&
              !firstParty &&
              step.kind !== "denied" &&
              step.kind !== "error" && (
                <>
                  <div className="flex flex-col gap-2.5 rounded-lg bg-foreground/[0.03] px-4 py-3 ring-1 ring-inset ring-foreground/10">
                    <Row label="Application" value={context.data.clientName} />
                    {/* Any client can register itself a minute before asking — a
                    fresh registration for a familiar name is worth a pause. */}
                    <Row
                      label="Registered"
                      value={formatRelative(context.data.registeredAt)}
                    />
                    {/* An app sign-in names WHO registered the app on this pod —
                    the person decides whether to trust it as that member. */}
                    {appSignIn ? (
                      <Row
                        label="Registered by"
                        value={appSignIn.registeredBy}
                      />
                    ) : null}
                    {/* The host the authorization code is actually delivered to —
                    the single most useful signal for spotting a bad request,
                    and the one field a user must read IN FULL. NOT rendered
                    through `Row`: `Row` truncates the end, so `claude.ai.evil.com`
                    would read as `claude.ai.evi…`, hiding the real registrable
                    domain — the exact string phishing relies on. Full-width,
                    wrapping, at elevated weight: the redirect host, not the
                    attacker-choosable Application name, is this screen's trust
                    anchor. */}
                    <div className="flex flex-col gap-1 pt-0.5">
                      <span className="text-sm text-foreground/65">
                        Sends you back to
                      </span>
                      <HostName
                        host={context.data.redirectHost}
                        className="text-sm text-foreground/90"
                      />
                    </div>
                    {appSignIn ? (
                      <div className="flex flex-col gap-2 pt-1.5">
                        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.04em] text-foreground/65">
                          <ShieldCheck className="h-3 w-3" aria-hidden /> It
                          will act as you
                        </p>
                        <ul className="flex flex-col gap-2">
                          {appSignIn.spaces.map((space) => (
                            <li
                              key={space.workspaceId}
                              className="flex items-start gap-2"
                            >
                              <Check
                                className="mt-[3px] h-3 w-3 shrink-0 text-primary"
                                aria-hidden
                                strokeWidth={2.4}
                              />
                              <span className="text-xs leading-relaxed text-foreground/75">
                                <span className="font-medium text-foreground/90">
                                  {space.name}
                                </span>
                                : {space.can}
                              </span>
                            </li>
                          ))}
                        </ul>
                        <p className="text-xs leading-relaxed text-foreground/75">
                          {appSignIn.cannot}
                        </p>
                        <p className="text-xs leading-relaxed text-foreground/65">
                          {appSignIn.note}
                        </p>
                      </div>
                    ) : (
                      <div className="pt-1.5">
                        <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.04em] text-foreground/65">
                          <ShieldCheck className="h-3 w-3" aria-hidden /> It
                          will be able to
                        </p>
                        <ul className="flex flex-col gap-2">
                          {context.data.scopes.map((s) => (
                            <li key={s} className="flex items-start gap-2">
                              <Check
                                className="mt-[3px] h-3 w-3 shrink-0 text-primary"
                                aria-hidden
                                strokeWidth={2.4}
                              />
                              <span className="text-xs leading-relaxed text-foreground/75">
                                {SCOPE_DESCRIPTIONS[s] ?? s}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>

                  <div className="flex gap-2.5">
                    <Button
                      color="primary"
                      radius="md"
                      size="md"
                      className="flex-1 font-medium"
                      isDisabled={busy}
                      isLoading={busy && step.approve}
                      onPress={() => act(true)}
                    >
                      Allow
                    </Button>
                    <Button
                      variant="flat"
                      radius="md"
                      size="md"
                      className="flex-1"
                      isDisabled={busy}
                      isLoading={busy && !step.approve}
                      onPress={() => act(false)}
                    >
                      Decline
                    </Button>
                  </div>

                  <p className="text-center text-xs leading-relaxed text-foreground/65">
                    You can revoke this connection at any time from{" "}
                    <a
                      href="/my-connections"
                      className="text-foreground/65 underline underline-offset-2"
                    >
                      Connected
                    </a>
                    .
                  </p>
                </>
              )}

            {step.kind === "denied" && (
              <div className="flex flex-col items-center gap-3 py-6 text-center">
                <span
                  aria-hidden
                  className="flex h-12 w-12 items-center justify-center rounded-full bg-foreground/[0.06] text-foreground/65 ring-1 ring-inset ring-foreground/15"
                >
                  <X className="h-6 w-6" strokeWidth={2.2} />
                </span>
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium text-foreground">
                    Declined
                  </p>
                  <p className="max-w-[18rem] text-xs text-foreground/65">
                    Nothing was connected. You can close this tab.
                  </p>
                </div>
              </div>
            )}

            {step.kind === "error" && (
              <div className="flex flex-col gap-4">
                <Problem
                  title="Couldn't complete the authorization"
                  message={step.message}
                />
                <Button
                  color="primary"
                  radius="md"
                  size="md"
                  className="font-medium"
                  onPress={() => setStep({ kind: "idle" })}
                >
                  Try again
                </Button>
              </div>
            )}
          </>
        )}
      </CardBody>
    </ReceiverShell>
  );
}

/** `127.0.0.1:<port>` or `[::1]:<port>`: the app is listening on this computer. */
function isLoopbackHost(host: string): boolean {
  return host.startsWith("127.0.0.1:") || host.startsWith("[::1]:");
}

/**
 * Shown instead of the decision while the person is sent to sign in again
 * (`prompt=login` / `max_age`): nothing on this screen can be decided yet.
 */
export function ReconfirmingNotice() {
  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-lg bg-foreground/[0.03] px-4 py-3 ring-1 ring-inset ring-foreground/10"
    >
      <Spinner size="sm" />
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">
          Confirming it&apos;s you…
        </span>
        <span className="text-xs text-foreground/65">
          Taking you to sign in again. You come back here after.
        </span>
      </div>
    </div>
  );
}

/**
 * A Synap app's "Confirm it's you" answered with Synap Cloud only. Cloud may
 * sign a person in without asking anything, so the pod asks for its own
 * password or passkey; a Cloud-only person makes the change here instead.
 */
export function PodCredentialNotice({
  name,
  onContinue,
}: {
  name: string;
  onContinue: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div
        role="status"
        className="flex flex-col gap-1 rounded-lg bg-foreground/[0.03] px-4 py-3 ring-1 ring-inset ring-foreground/10"
      >
        <span className="text-sm font-medium text-foreground">
          Confirm with your password or passkey
        </span>
        <span className="text-xs leading-relaxed text-foreground/65">
          {name} asks you to confirm it&apos;s you. Synap Cloud can&apos;t
          confirm that here, because it can sign you in without asking.
        </span>
        <span className="text-xs leading-relaxed text-foreground/65">
          Only sign in with Synap Cloud? Make the change from this console, in
          your browser.
        </span>
      </div>
      <Button color="primary" className="self-start" onPress={onContinue}>
        Use your password or passkey
      </Button>
    </div>
  );
}

/**
 * A Synap app signing the person in on this device. Always
 * a click, never silent: a loopback redirect cannot prove which program is
 * listening (RFC 8252 §8.6), so the person confirms the app they just opened.
 */
export function FirstPartyConsent({
  name,
  onComputer,
  redirectHost,
  reconfirm,
  busy,
  step,
  onDecide,
}: {
  name: string;
  onComputer: boolean;
  redirectHost: string;
  reconfirm: boolean;
  busy: boolean;
  step: Step;
  onDecide: (approve: boolean) => void;
}) {
  const Glyph = onComputer ? Monitor : Smartphone;
  return (
    <>
      <div className="flex flex-col gap-2.5 rounded-lg bg-foreground/[0.03] px-4 py-3 ring-1 ring-inset ring-foreground/10">
        <p className="flex items-center gap-1.5 text-sm font-medium text-foreground/85">
          <Glyph className="h-3.5 w-3.5" aria-hidden />
          {reconfirm
            ? `${name} is already signed in.`
            : `${name} will act as you.`}
        </p>
        <p className="text-xs leading-relaxed text-foreground/75">
          {reconfirm
            ? `It asks before it changes a key, a connection or a secret. Only continue if you just asked ${name} to do that.`
            : `It can do what you can do in Synap. Only continue if you just opened ${name} and asked it to sign in.`}
        </p>
        <div className="flex flex-col gap-1 pt-0.5">
          <span className="text-sm text-foreground/65">Sends you back to</span>
          {onComputer ? (
            <span className="text-sm text-foreground/90">This computer</span>
          ) : (
            <HostName
              host={redirectHost}
              className="text-sm text-foreground/90"
            />
          )}
        </div>
      </div>

      <div className="flex gap-2.5">
        <Button
          color="primary"
          radius="md"
          size="md"
          className="flex-1 font-medium"
          isDisabled={busy}
          isLoading={busy && step.kind === "working" && step.approve}
          onPress={() => onDecide(true)}
        >
          {reconfirm ? "Confirm" : "Sign in"}
        </Button>
        <Button
          variant="flat"
          radius="md"
          size="md"
          className="flex-1"
          isDisabled={busy}
          isLoading={busy && step.kind === "working" && !step.approve}
          onPress={() => onDecide(false)}
        >
          Cancel
        </Button>
      </div>
      <p className="text-center text-xs leading-relaxed text-foreground/65">
        You can sign it out any time from{" "}
        <Link href="/my-connections" className="underline underline-offset-2">
          {SIGNED_IN_APPS_COPY.title}
        </Link>
        .
      </p>
    </>
  );
}

/** A pod app's consent section, as `getOAuthConsentContext` returns it. */
type ConsentApp = NonNullable<
  inferRouterOutputs<AppRouter>["apiKeys"]["getOAuthConsentContext"]["app"]
>;

/**
 * Every checkbox on this screen (a space, a section's "All"):
 * - base: a 40px row to tap, with no two rows' hit areas overlapping
 *   (HeroUI's base is `p-2 -m-2`);
 * - wrapper: an unticked box drawn in `default-500`. HeroUI's own
 *   `before:border-default` is `default` (#1B1E22 dark, #F4F2EE light), the
 *   card's colour, so an empty box all but vanished. `default-500` against the
 *   card: 5.0:1 dark, 4.6:1 light (non-text needs 3:1). Here only: pod-admin
 *   has no shared checkbox.
 */
export const CONSENT_CHECKBOX = {
  base: "my-0 min-h-10 py-0",
  wrapper: "before:border-default-500",
} as const;

/**
 * A section's heading and its one tri-state checkbox: every permission ×
 * space of the section ticked, some, or none. A section with no space to give
 * has nothing to select, so it gets no checkbox.
 */
function SectionHeading({
  id,
  title,
  section,
  permissions,
  selection,
  onToggleSection,
  busy,
}: {
  id: string;
  title: string;
  section: "grants" | "decisions";
  permissions: readonly OfferedPermission[];
  selection: Selection;
  onToggleSection: () => void;
  busy: boolean;
}) {
  const state = sectionState(selection, permissions);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3">
      <p
        id={id}
        className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.04em] text-foreground/65"
      >
        <ShieldCheck className="h-3 w-3" aria-hidden /> {title}
      </p>
      {permissions.some((p) => p.workspaces.length > 0) ? (
        <Checkbox
          size="sm"
          classNames={CONSENT_CHECKBOX}
          aria-label={sectionCheckboxLabel(section)}
          isSelected={state === "all"}
          isIndeterminate={state === "some"}
          isDisabled={busy}
          onValueChange={onToggleSection}
        >
          All
        </Checkbox>
      ) : null}
    </div>
  );
}

/** One line per permission, with a tick for each space it may be given in. */
function PermissionList({
  permissions,
  selection,
  onToggle,
  busy,
}: {
  permissions: readonly OfferedPermission[];
  selection: Selection;
  onToggle: (permission: string, workspaceId: string) => void;
  busy: boolean;
}) {
  const groupId = useId();
  return (
    <ul className="flex flex-col gap-3">
      {permissions.map((p, i) => {
        const labelId = `${groupId}-p${i}`;
        const reason = reasonOf(p);
        return (
          <li key={p.permission} className="flex flex-col gap-1.5">
            <span id={labelId} className="text-sm text-foreground/85">
              {permissionLabel(p.permission)}{" "}
              <span className="font-mono text-xs text-foreground/65">
                {p.permission}
              </span>
            </span>
            {reason ? (
              <p className="text-pretty text-xs leading-relaxed text-foreground/75">
                {/* The developer's words, as text: why it asks. */}
                <span className="text-foreground/65">Its reason: </span>
                {reason}
              </p>
            ) : null}
            {p.workspaces.length === 0 ? (
              <span className="text-xs text-foreground/65">
                You have no space where you can give it this.
              </span>
            ) : (
              <div
                role="group"
                aria-labelledby={labelId}
                className="flex flex-wrap gap-x-4"
              >
                {p.workspaces.map((w) => (
                  <Checkbox
                    key={w.workspaceId}
                    size="sm"
                    classNames={CONSENT_CHECKBOX}
                    aria-label={spaceCheckboxLabel(
                      p.permission,
                      w.workspaceName
                    )}
                    isSelected={isTicked(
                      selection,
                      p.permission,
                      w.workspaceId
                    )}
                    isDisabled={busy}
                    onValueChange={() => onToggle(p.permission, w.workspaceId)}
                  >
                    {w.workspaceName}
                  </Checkbox>
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A row's level control: a segmented radio group (arrow keys move, one tab
 * stop), named for its object. The ring is `default-500` (5.0:1 dark, 4.6:1
 * light against the card, as `CONSENT_CHECKBOX`); the segments are 36px
 * inside a 2px inset, so each target is 40px tall. A level that gives
 * something fills with the primary colour; Off fills neutral.
 */
export const LEVEL_GROUP = {
  base: "shrink-0 gap-0",
  wrapper:
    "flex-nowrap gap-0.5 rounded-lg p-0.5 ring-1 ring-inset ring-default-500",
} as const;
const SEGMENT_BASE =
  "m-0 min-h-9 min-w-12 max-w-none justify-center rounded-md px-3 py-0 hover:bg-default-100 data-[focus-visible=true]:z-10 data-[focus-visible=true]:ring-2 data-[focus-visible=true]:ring-focus";
export const LEVEL_SEGMENT = {
  base: `${SEGMENT_BASE} data-[selected=true]:bg-primary data-[selected=true]:hover:bg-primary`,
  wrapper: "hidden",
  labelWrapper: "m-0 ml-0",
  label:
    "text-sm text-foreground/80 group-data-[selected=true]:font-medium group-data-[selected=true]:text-primary-foreground",
} as const;
export const LEVEL_SEGMENT_OFF = {
  ...LEVEL_SEGMENT,
  base: `${SEGMENT_BASE} data-[selected=true]:bg-default-200 data-[selected=true]:hover:bg-default-200`,
  label:
    "text-sm text-foreground/80 group-data-[selected=true]:font-medium group-data-[selected=true]:text-foreground",
} as const;

function LevelControl({
  row,
  level,
  isDisabled,
  onChange,
}: {
  row: ConsentObject;
  level: AccessLevel;
  isDisabled: boolean;
  onChange: (level: AccessLevel) => void;
}) {
  return (
    <RadioGroup
      orientation="horizontal"
      aria-label={levelControlLabel(row)}
      value={level}
      isDisabled={isDisabled}
      onValueChange={(v) => onChange(v as AccessLevel)}
      classNames={LEVEL_GROUP}
    >
      {row.levels.map((l) => (
        <Radio
          key={l}
          value={l}
          classNames={l === "off" ? LEVEL_SEGMENT_OFF : LEVEL_SEGMENT}
        >
          {LEVEL_WORDS[l]}
        </Radio>
      ))}
    </RadioGroup>
  );
}

/**
 * One object the app asks about: its name and where it is given (the
 * button opens its detail), and its level. The detail lists each permission
 * in words with its raw token, the developer's reason, and a tick per space:
 * the row's own and default spaces, then the rest behind "Also allow in
 * another space…". "It can also see" names its objects instead, and its
 * detail lists each as its own row (View or Off, its own spaces).
 */
function ObjectRow({
  row,
  selection,
  templates,
  podWide,
  busy,
  onSetLevel,
  onToggleSpace,
}: {
  row: ConsentObject;
  selection: Selection;
  templates: readonly string[];
  /** The row's kind is kept pod-wide (the server's `podWideKinds`). */
  podWide: (row: ConsentObject) => boolean;
  busy: boolean;
  onSetLevel: (row: ConsentObject, level: AccessLevel) => void;
  onToggleSpace: (row: ConsentObject, workspaceId: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const folded = row.members.length > 0;
  const scope = folded
    ? alsoSeeLine(selection, row)
    : scopeLabel(objectSpaces(selection, row));
  const noSpace = row.permissions.every((p) => p.workspaces.length === 0);
  return (
    <li className="flex flex-col py-1" data-object={row.key}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-detail`}
          onClick={() => setOpen((o) => !o)}
          className="-mx-1 flex min-h-10 min-w-0 flex-1 basis-40 items-center gap-1.5 rounded-md px-1 text-left hover:bg-foreground/[0.04] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <ChevronRight
            aria-hidden
            className={`h-4 w-4 shrink-0 text-foreground/65 transition-transform ${open ? "rotate-90" : ""}`}
          />
          <span className="flex min-w-0 flex-col">
            <span className="text-sm font-medium text-foreground/90">
              {row.label}
            </span>
            {scope ? (
              <span className="text-xs text-foreground/65">{scope}</span>
            ) : row.decisions ? (
              <span className="text-xs text-foreground/65">
                {decideLine(row)}
              </span>
            ) : null}
          </span>
        </button>
        {noSpace ? (
          <span className="text-xs text-foreground/65">No space to give</span>
        ) : (
          <LevelControl
            row={row}
            level={objectLevel(selection, row)}
            isDisabled={busy}
            onChange={(level) => onSetLevel(row, level)}
          />
        )}
      </div>
      <div
        id={`${id}-detail`}
        hidden={!open}
        // A class's `display` beats the `hidden` attribute: keep both.
        className={`${open ? "flex" : "hidden"} flex-col gap-2 pb-2 pl-6 pt-1`}
      >
        {folded ? (
          <ul className="flex flex-col divide-y divide-foreground/10">
            {row.members.map((m) => (
              <ObjectRow
                key={m.key}
                row={m}
                selection={selection}
                templates={templates}
                podWide={podWide}
                busy={busy}
                onSetLevel={onSetLevel}
                onToggleSpace={onToggleSpace}
              />
            ))}
          </ul>
        ) : (
          <ObjectDetail
            row={row}
            selection={selection}
            templates={templates}
            podWide={podWide(row)}
            busy={busy}
            onToggleSpace={onToggleSpace}
          />
        )}
      </div>
    </li>
  );
}

/** A row's detail: its permissions in words, its reasons, a tick per space. */
function ObjectDetail({
  row,
  selection,
  templates,
  podWide,
  busy,
  onToggleSpace,
}: {
  row: ConsentObject;
  selection: Selection;
  templates: readonly string[];
  podWide: boolean;
  busy: boolean;
  onToggleSpace: (row: ConsentObject, workspaceId: string) => void;
}) {
  const id = useId();
  const [more, setMore] = useState(false);
  const shown = shownSpaces(selection, row, templates);
  const others = otherSpaces(selection, row, templates);
  const tick = (w: { workspaceId: string; workspaceName: string }) => (
    <Checkbox
      key={w.workspaceId}
      size="sm"
      classNames={CONSENT_CHECKBOX}
      aria-label={objectSpaceLabel(row, w.workspaceName)}
      isSelected={holdsSpace(selection, row, w.workspaceId)}
      isDisabled={busy}
      onValueChange={() => onToggleSpace(row, w.workspaceId)}
    >
      {w.workspaceName}
    </Checkbox>
  );
  return (
    <>
      <ul className="flex flex-col gap-1.5">
        {row.permissions.map((p) => {
          const reason = reasonOf(p);
          return (
            <li key={p.permission} className="flex flex-col gap-0.5">
              <span className="text-xs text-foreground/85">
                {permissionLabel(p.permission)}{" "}
                <span className="font-mono text-[11px] text-foreground/65">
                  {p.permission}
                </span>
              </span>
              {reason ? (
                <span className="text-pretty text-xs leading-relaxed text-foreground/75">
                  {/* The developer's words, as text: why it asks. */}
                  <span className="text-foreground/65">Its reason: </span>
                  {reason}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {podWide ? (
        <p className="text-xs leading-relaxed text-foreground/75">
          {podWideNote(row)}
        </p>
      ) : null}
      {shown.length > 0 ? (
        <div
          role="group"
          aria-label={`${row.label}: where`}
          className="flex flex-wrap gap-x-4"
        >
          {shown.map(tick)}
        </div>
      ) : null}
      {others.length > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={more}
            aria-controls={`${id}-more`}
            onClick={() => setMore((m) => !m)}
            className="flex min-h-10 items-center self-start rounded-sm text-xs text-foreground/75 underline underline-offset-2 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Also allow in another space…
          </button>
          <div
            id={`${id}-more`}
            hidden={!more}
            role="group"
            aria-label={`${row.label}: other spaces`}
            className={`${more ? "flex" : "hidden"} flex-wrap gap-x-4`}
          >
            {others.map(tick)}
          </div>
        </>
      ) : null}
    </>
  );
}

/**
 * A pod app's consent (spec 17 §9.1): its domain is the headline (above), and
 * the person gives it, OBJECT by object, a level (Edit, View or Off) in the
 * spaces made from its declared templates (`groupByObject`, `setObjectLevel`)
 * — only from what the pod offers, so the screen can narrow and never widen.
 * "Customize…" shows the permission × space matrix, each section selecting
 * or clearing as a whole; both views edit the same selection.
 */
export function AppConsent({
  app,
  registeredAt,
  redirectHost,
  selection,
  onToggle,
  onToggleSection,
  onSetLevel,
  onToggleObjectSpace,
  customize,
  onCustomize,
  onSpaceCreated,
  busy,
  step,
  blockedReason,
  onDecide,
}: {
  app: ConsentApp;
  registeredAt: Date | string;
  redirectHost: string;
  selection: Selection;
  onToggle: (permission: string, workspaceId: string) => void;
  /** The section checkbox pressed (`toggleSection` on that section). */
  onToggleSection: (section: readonly OfferedPermission[]) => void;
  /** A row's level pressed (`setObjectLevel`). */
  onSetLevel: (row: ConsentObject, level: AccessLevel) => void;
  /** A row's space tick pressed (`toggleObjectSpace`). */
  onToggleObjectSpace: (row: ConsentObject, workspaceId: string) => void;
  /**
   * The full permission × space matrix is shown instead of the rows. Both
   * edit the same `selection`.
   */
  customize: boolean;
  onCustomize: (customize: boolean) => void;
  onSpaceCreated: () => void;
  busy: boolean;
  step: Step;
  /** Why Allow cannot be pressed (`allowBlockedReason`), or null. */
  blockedReason: string | null;
  onDecide: (approve: boolean) => void;
}) {
  const missing = withoutSpace(app.permissions);
  // Decisions (approve / reject) are their own line, never part of a write.
  const { grants, decisions } = splitOffer(app.permissions);
  const rows = useMemo(() => groupByObject(app.permissions), [app.permissions]);
  const objects = rows.filter((r) => !r.decisions);
  const decide = rows.filter((r) => r.decisions);
  const groupId = useId();
  // The server's list of pod-wide kinds, never a hand list.
  const podWide = (row: ConsentObject) =>
    !!row.kind && app.podWideKinds.includes(row.kind);
  const objectRow = (row: ConsentObject) => (
    <ObjectRow
      key={row.key}
      row={row}
      selection={selection}
      templates={app.templates}
      podWide={podWide}
      busy={busy}
      onSetLevel={onSetLevel}
      onToggleSpace={onToggleObjectSpace}
    />
  );
  return (
    <>
      <div className="flex flex-col gap-3 rounded-lg bg-foreground/[0.03] px-4 py-3 ring-1 ring-inset ring-foreground/10">
        {!customize && objects.length > 0 && (
          <section
            aria-labelledby={`${groupId}-objects`}
            className="flex flex-col"
          >
            <p
              id={`${groupId}-objects`}
              className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.04em] text-foreground/65"
            >
              <ShieldCheck className="h-3 w-3" aria-hidden /> It asks to
            </p>
            <ul className="flex flex-col divide-y divide-foreground/10">
              {objects.map(objectRow)}
            </ul>
          </section>
        )}
        {!customize && decide.length > 0 && (
          <section
            aria-labelledby={`${groupId}-decide`}
            className="flex flex-col"
          >
            <p
              id={`${groupId}-decide`}
              className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.04em] text-foreground/65"
            >
              <ShieldCheck className="h-3 w-3" aria-hidden /> It asks to decide
              for you
            </p>
            <ul className="flex flex-col">{decide.map(objectRow)}</ul>
          </section>
        )}
        {customize && grants.length > 0 && (
          <section
            aria-labelledby={`${groupId}-grants`}
            className="flex flex-col gap-1"
          >
            <SectionHeading
              id={`${groupId}-grants`}
              title="It asks to"
              section="grants"
              permissions={grants}
              selection={selection}
              onToggleSection={() => onToggleSection(grants)}
              busy={busy}
            />
            <PermissionList
              permissions={grants}
              selection={selection}
              onToggle={onToggle}
              busy={busy}
            />
          </section>
        )}
        {customize && decisions.length > 0 && (
          <section
            aria-labelledby={`${groupId}-decisions`}
            className="flex flex-col gap-1"
          >
            <SectionHeading
              id={`${groupId}-decisions`}
              title="It asks to decide for you"
              section="decisions"
              permissions={decisions}
              selection={selection}
              onToggleSection={() => onToggleSection(decisions)}
              busy={busy}
            />
            <PermissionList
              permissions={decisions}
              selection={selection}
              onToggle={onToggle}
              busy={busy}
            />
            <p className="pt-2 text-xs leading-relaxed text-foreground/65">
              Each decision is yours, on one change at a time. Nothing above
              includes it: tick the spaces where you allow it.
            </p>
          </section>
        )}
        {/* Once, under the rows or the matrix, for any record read (rv-ui U1/U3). */}
        {readsSpaceRecords(app.permissions) && (
          <p className="text-pretty text-xs leading-relaxed text-foreground/75">
            {SPACE_REACH_NOTE}
          </p>
        )}
        {rows.length > 0 && (
          <Button
            size="sm"
            variant="light"
            radius="md"
            className="min-h-10 self-start px-2 text-foreground/80"
            isDisabled={busy}
            onPress={() => onCustomize(!customize)}
          >
            {customize ? "Simple view" : "Customize…"}
          </Button>
        )}
        {app.ignoredScopes.length > 0 && (
          <p className="text-xs text-foreground/65">
            It also asked for {app.ignoredScopes.join(", ")}, which apps are not
            given.
          </p>
        )}
        {/* Who its token acts as, in the server's words (`actsAs`). */}
        <p className="text-xs leading-relaxed text-foreground/65">
          {app.actsAs.note}
        </p>
        <div className="flex flex-col gap-1 pt-0.5">
          <span className="text-sm text-foreground/65">Sends you back to</span>
          <HostName
            host={redirectHost}
            className="text-sm text-foreground/90"
          />
        </div>
        <Row label="First seen" value={formatRelative(registeredAt)} />
      </div>

      {missing.length > 0 && (
        <CreateSpace
          templates={app.templates}
          domain={app.domain}
          onCreated={onSpaceCreated}
        />
      )}

      <div className="flex flex-col gap-2">
        <div className="flex gap-2.5">
          <Button
            color="primary"
            radius="md"
            size="md"
            className="flex-1 font-medium"
            isDisabled={busy || blockedReason !== null}
            isLoading={busy && step.kind === "working" && step.approve}
            aria-describedby={blockedReason ? `${groupId}-blocked` : undefined}
            onPress={() => onDecide(true)}
          >
            Allow
          </Button>
          <Button
            variant="flat"
            radius="md"
            size="md"
            className="flex-1"
            isDisabled={busy}
            isLoading={busy && step.kind === "working" && !step.approve}
            onPress={() => onDecide(false)}
          >
            Decline
          </Button>
        </div>
        {blockedReason ? (
          <p
            id={`${groupId}-blocked`}
            className="text-center text-xs text-foreground/75"
          >
            {blockedReason}
          </p>
        ) : null}
      </div>
      <p className="text-pretty text-center text-xs leading-relaxed text-foreground/65">
        You can revoke it at any time from{" "}
        <a
          href="/my-connections"
          className="text-foreground/75 underline underline-offset-2"
        >
          Connected
        </a>
        . Revoking there stops it in every browser, not just this one.
      </p>
    </>
  );
}

/**
 * doc 18: a person may have no space to give the app. When the app declares
 * workspace templates (`synap_templates`), offer to create the space from one
 * with the person's OWN session (`workspaces.ensureTemplate`, governed like
 * any create); the offer is then re-read. Otherwise say what is missing.
 */
function CreateSpace({
  templates,
  domain,
  onCreated,
}: {
  templates: string[];
  domain: string;
  onCreated: () => void;
}) {
  const ensure = trpc.workspaces.ensureTemplate.useMutation();
  const [note, setNote] = useState<string | null>(null);
  const create = (slug: string) => {
    setNote(null);
    ensure.mutate(
      { slug, install: true, reason: `For the app ${domain}` },
      {
        onSuccess: (r) => {
          if (
            r.status === "installed" ||
            r.status === "installing" ||
            r.status === "exists"
          ) {
            onCreated();
          } else if (r.status === "proposed") {
            setNote(
              "Creating the space was sent for review. Approve it, then reload this page."
            );
          } else {
            setNote(`This space can't be created here (${r.status}).`);
          }
        },
        onError: (err) => setNote(err.message),
      }
    );
  };
  if (templates.length === 0) {
    // A state, not an error (rv-ui U9): the screen's neutral hint tone.
    return (
      <div
        role="status"
        className="flex flex-col gap-1 rounded-lg bg-foreground/[0.03] px-4 py-3 ring-1 ring-inset ring-foreground/10"
      >
        <span className="text-sm font-medium text-foreground">
          No space to give it
        </span>
        <span className="text-xs leading-relaxed text-foreground/65">
          You have no space where you can give this app what it asks for.
        </span>
        <span className="text-xs leading-relaxed text-foreground/65">
          Create a space in Synap (or ask for edit rights in one), then reload
          this page.
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg px-4 py-3 ring-1 ring-inset ring-foreground/10">
      <p className="text-sm text-foreground/80">
        You have no space where you can give it everything it asks for. Create
        one it can work in:
      </p>
      <div className="flex flex-wrap gap-2">
        {templates.map((slug) => (
          <Button
            key={slug}
            size="sm"
            variant="flat"
            isLoading={ensure.isPending && ensure.variables?.slug === slug}
            isDisabled={ensure.isPending}
            onPress={() => create(slug)}
          >
            Create a space from &ldquo;{slug}&rdquo;
          </Button>
        ))}
      </div>
      {note && <p className="text-xs text-foreground/65">{note}</p>}
    </div>
  );
}

function Problem({
  title,
  message,
  hint,
}: {
  title: string;
  message: string;
  /** A recovery step. A permanent error with no way forward strands the user. */
  hint?: string;
}) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg bg-danger/10 px-3.5 py-3 ring-1 ring-inset ring-danger/30">
      <X
        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger"
        strokeWidth={2.2}
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-0.5 break-words text-xs text-foreground/75">
          {message}
        </p>
        {hint && (
          <p className="mt-1.5 text-pretty text-xs text-foreground/75">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="shrink-0 text-foreground/65">{label}</span>
      <span className="min-w-0 truncate text-foreground/85">{value}</span>
    </div>
  );
}

"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@synap-core/api-types";
import { ReceiverShell } from "../../_lib/receiver-shell";
import { HostName } from "../../_lib/host-name";
import {
  Accordion,
  AccordionItem,
  Alert,
  Button,
  CardBody,
  CardHeader,
  Chip,
  Spinner,
  Switch,
} from "@heroui/react";
import {
  Ban,
  Check,
  Info,
  Monitor,
  Plug,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Sparkles,
  X,
} from "lucide-react";

import Link from "next/link";
import {
  FIRST_PARTY_CLIENT_NAMES,
  buildObjectActionTitle,
  humanizeToken,
  resolveOAuthScopeLabel,
} from "@synap-core/types/vocabulary";
import { SIGNED_IN_APPS_COPY } from "@synap-core/types/sign-in";
import { formatRelative } from "../../../lib/format";
import { trpc } from "../../../lib/trpc";
import { useDecideOAuthAuthorization } from "../../_lib/presence/use-request-doors";
import {
  clientDomain,
  consentClientKind,
  consentWidth,
  invalidRequestHint,
  spaceHintFirst,
} from "./consent-model";
import {
  allowNew,
  canRows,
  cantGive,
  heldPermissionsOf,
  contractDraft,
  contractOf,
  firstDraft,
  heldOfContract,
  namesOfNamed,
  offerOfContract,
  wasPairs,
  draftBlockedReason,
  draftHeadline,
  heldAccessOf,
  newAllowed,
  offerOf,
  placeNames,
  reconsentChanges,
  reconsentDraft,
  setPermission,
  type CantGive,
  type ConsentDraft,
  type ReconsentChange,
} from "./consent-access";
import { AccessLines } from "./AccessLines";
import { consentT } from "./copy";
import { AskConsent, askCurrentOf, askViewOf } from "./AskConsent";
import { allowPayload, showsErrorScreen } from "./allow-payload";

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
  /**
   * A pod app's `synap_ask`: it asks for ONE MORE thing (the short consent).
   * Re-resolved server-side; the screen shows only what the server returns.
   */
  synapAsk?: string;
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

  // With the proof of presence: connecting an app or an AI client is setup
  // (W3). "Sign in with Synap" (an `app` client: no AI, no key) is the one
  // consent the pod does not gate.
  const decide = useDecideOAuthAuthorization({
    needsProof: !!context.data && context.data.clientKind !== "app",
    label: context.data?.clientName
      ? buildObjectActionTitle({
          action: "connect",
          objectKind: "app",
          objectName: context.data.clientName,
        })
      : null,
  });

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

  // A pod app (CIMD client): the person gives it a draft of AppAccess v2
  // ("It can", "In", "It changes things in"), bounded by the offer.
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
  // The W3d contract (`app.access`) when this pod sends it; else today's offer.
  const contract = useMemo(() => contractOf(app), [app]);
  const offer = useMemo(
    () =>
      app
        ? contract
          ? offerOfContract(contract, spaceHint)
          : offerOf(app)
        : null,
    [app, contract, spaceHint]
  );
  const [draft, setDraft] = useState<ConsentDraft | null>(null);
  useEffect(() => {
    if (app && offer) {
      // A re-consent starts from what the connection holds, a first consent
      // from the app's declared defaults (`firstDraft`, writes only for an
      // app Synap checked).
      setDraft(
        contract
          ? contractDraft(contract, offer, { verified: app.verified })
          : reconsentDraft(heldAccessOf(app.approved), offer, {
              verified: app.verified,
            })
      );
    }
  }, [app, offer, contract]);
  // A re-consent says what changes first; its title and buttons follow.
  const confirming = useMemo(
    () =>
      !!app &&
      !!offer &&
      reconsentChanges(
        contract ? heldOfContract(contract) : heldAccessOf(app.approved),
        offer,
        canRows(offer, app.actsAs.kind),
        contract?.reconsent ? wasPairs(contract.reconsent) : app.approved,
        contract ? heldPermissionsOf(contract) : undefined
      ).length > 0,
    [app, offer, contract]
  );
  // An app Synap has not checked is named by its domain, never by the name
  // it gives itself (its `client_name` is its own words).
  const appName = app
    ? app.verified
      ? (context.data?.clientName ?? app.domain)
      : app.domain
    : "";
  const t = consentT();
  // The short ask: the contract's (v1.1: only when the connection names a
  // project) when the pod sends it, else today's pairs.
  const ask = app?.ask ?? null;
  const askView = app && offer ? askViewOf({ ask, contract, offer }) : null;
  // Q4: the first write place a short ask needs. It starts on the ask's own
  // spaces, else the server's suggestion for an app Synap checked.
  const [askWrite, setAskWrite] = useState<ConsentDraft | null>(null);
  const askWriteDraft =
    askView?.needsWritePlace && offer && app
      ? (askWrite ?? {
          ...firstDraft(offer, { verified: app.verified }),
          write: {
            spaces:
              askView.askedSpaceIds.length > 0
                ? [...askView.askedSpaceIds]
                : app.verified
                  ? [...(contract?.places.write.suggestedSpaceIds ?? [])]
                  : [],
            projects: [],
          },
        })
      : null;
  // What Allow sends, from ONE pure rule (`allowPayload`, tested).
  const payload = allowPayload({
    app,
    contract,
    offer,
    draft,
    askWrite: askWriteDraft,
  });

  const act = useCallback(
    (approve: boolean) => {
      setStep({ kind: "working", approve });
      decide.mutate(
        {
          ...params,
          approve,
          // Spread, not written inline: the generated input type gains
          // `access` / `askWritePlace` with W3d's PR (#1197); until then an
          // older pod ignores them.
          ...payload,
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
    [decide, params, payload, context.data]
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
          // An app registered by its metadata document is named by its
          // domain too: its name is its own words, the domain is proven.
          domain: clientDomain(context.data.clientId),
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
            {firstParty
              ? "Sign-in request"
              : app && (askView || confirming)
                ? t("eyebrow.access")
                : t("eyebrow.connection")}
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
            <PodAppHeading
              domain={app.domain}
              verified={app.verified}
              clientName={context.data?.clientName ?? app.domain}
              podHost={podHost}
              identity={identity}
              title={
                askView
                  ? t("ask.title", { name: appName, n: askView.lines.length })
                  : t(confirming ? "title.confirm" : "title.connect", {
                      name: appName,
                    })
              }
            />
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
            {context.isLoading &&
              (consentClientKind(params.clientId) === "pod_app" ? (
                <ConsentSkeleton />
              ) : (
                <div className="flex items-center justify-center py-10">
                  <Spinner size="sm" />
                </div>
              ))}

            {context.isError &&
              (isTransient(context.error) ? (
                <ReadFailed
                  onRetry={() => void context.refetch()}
                  retrying={context.isFetching}
                  onDecline={() => act(false)}
                  busy={busy}
                />
              ) : (
                <Problem
                  title="This authorization request isn't valid"
                  message={context.error.message}
                  hint={invalidRequestHint(params.clientId)}
                />
              ))}

            {context.data &&
              app &&
              offer &&
              askView &&
              step.kind !== "denied" && (
                <AskConsent
                  appName={appName}
                  view={askView}
                  offer={offer}
                  current={askCurrentOf(app, contract)}
                  names={{
                    ...namesOfNamed(contract?.current),
                    ...placeNames(offer),
                  }}
                  writePlace={
                    askWriteDraft
                      ? { draft: askWriteDraft, onChange: setAskWrite }
                      : null
                  }
                  busy={busy}
                  step={step}
                  onDecide={act}
                />
              )}

            {context.data &&
              app &&
              offer &&
              draft &&
              !askView &&
              step.kind !== "denied" && (
                <AppConsent
                  app={app}
                  appName={appName}
                  registeredAt={context.data.registeredAt}
                  redirectHost={context.data.redirectHost}
                  draft={draft}
                  onDraft={setDraft}
                  onSpaceCreated={() => void context.refetch()}
                  busy={busy}
                  step={step}
                  blockedReason={draftBlockedReason(
                    draft,
                    offer,
                    canRows(offer, app.actsAs.kind)
                  )}
                  onDecide={act}
                  spaceHint={spaceHint}
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
                                {resolveOAuthScopeLabel(s)}
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
                    {askView || (app && app.approved.length > 0)
                      ? "Nothing was added; what it already has stays. You can close this tab."
                      : "Nothing was connected. You can close this tab."}
                  </p>
                </div>
              </div>
            )}

            {showsErrorScreen(step, app) && (
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
  domain,
  onComputer,
  redirectHost,
  reconfirm,
  busy,
  step,
  onDecide,
}: {
  name: string;
  /** The client_id's host for an app registered by its document, else null. */
  domain?: string | null;
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
        {domain ? (
          <div className="flex flex-col gap-1 pt-0.5">
            <span className="text-sm text-foreground/65">Published by</span>
            <HostName host={domain} className="text-sm text-foreground/90" />
          </div>
        ) : null}
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
export type ConsentApp = NonNullable<
  inferRouterOutputs<AppRouter>["apiKeys"]["getOAuthConsentContext"]["app"]
>;

/** The consent's own copy of the app's offer and rows, derived once per app. */
export function useConsentModel(app: ConsentApp, spaceHint?: string) {
  // The W3d contract when this pod sends it (`app.access`), else today's
  // per-permission offer: one model either way.
  const contract = useMemo(() => contractOf(app), [app]);
  const offer = useMemo(
    () => (contract ? offerOfContract(contract, spaceHint) : offerOf(app)),
    [app, contract, spaceHint]
  );
  const rows = useMemo(
    () => canRows(offer, app.actsAs.kind),
    [offer, app.actsAs.kind]
  );
  const held = useMemo(
    () => (contract ? heldOfContract(contract) : heldAccessOf(app.approved)),
    [app.approved, contract]
  );
  const changes = useMemo(
    () =>
      reconsentChanges(
        held,
        offer,
        rows,
        contract?.reconsent ? wasPairs(contract.reconsent) : app.approved,
        // What the connection already holds is never a "new" ask (C4).
        contract ? heldPermissionsOf(contract) : undefined
      ),
    [held, offer, rows, app.approved, contract]
  );
  const names = useMemo(
    () => ({
      ...namesOfNamed(contract?.current),
      ...namesOfNamed(contract?.reconsent?.proposed),
      ...placeNames(offer),
    }),
    [contract, offer]
  );
  return { contract, offer, rows, held, changes, names };
}

/**
 * A pod app's consent (design A, ui-design 814c0b8d): the live headline,
 * then three lines, "It can", "In" and "It changes things in", each with one
 * door. A re-consent first says what changes, each with a door that narrows
 * it; what it asks that cannot be given is folded below. Every choice edits
 * ONE draft (AppAccess v2's shape, `consent-access`), bounded by the offer:
 * the screen can narrow and never widen.
 */
export function AppConsent({
  app,
  appName,
  registeredAt,
  redirectHost,
  draft,
  onDraft,
  onSpaceCreated,
  busy,
  step,
  blockedReason,
  onDecide,
  defaultOpen,
  spaceHint,
}: {
  app: ConsentApp;
  /** The launch's space, listed first (order only, never sent). */
  spaceHint?: string;
  /** What the app calls itself: the domain for an app Synap has not checked. */
  appName: string;
  registeredAt: Date | string;
  redirectHost: string;
  draft: ConsentDraft;
  onDraft: (next: ConsentDraft) => void;
  onSpaceCreated: () => void;
  busy: boolean;
  step: Step;
  /** Why Allow cannot be pressed (`draftBlockedReason`), or null. */
  blockedReason: string | null;
  onDecide: (approve: boolean) => void;
  /** Which line's sheet starts open (a test, a screenshot). */
  defaultOpen?: "can" | "in" | "write" | null;
}) {
  const t = consentT();
  const { offer, rows, held, changes, names } = useConsentModel(app, spaceHint);
  const groupId = useId();
  const confirming = changes.length > 0;
  const moved = changes.filter((c) => c.mark !== "new");
  // "It can" changed only when the person changed it here: a narrowing door
  // pressed, or the new asks switched on (P4). "In" changes with the new form.
  const canChanged =
    moved.some(
      (c) => c.mark === "wider" && !draft.permissions.has(c.permission)
    ) ||
    changes.some(
      (c) => c.mark === "new" && draft.permissions.has(c.permission)
    );
  const cannot = cantGive(offer, app.ignoredScopes);
  const headline = draftHeadline(draft, offer, rows, names);
  const failed = step.kind === "error" ? step.message : null;
  return (
    <>
      {confirming ? (
        <ReconsentCallout
          appName={appName}
          changes={changes}
          draft={draft}
          busy={busy}
          onDraft={onDraft}
        />
      ) : null}
      {/* The ONE access sentence over the draft: the grant the token will
          carry, as the app's page will say it. */}
      <p
        aria-live="polite"
        className="text-pretty text-sm leading-relaxed text-foreground/90"
      >
        {headline}
      </p>
      <AccessLines
        mode="consent"
        appName={appName}
        declaredPlaces={offer.templates.length > 0}
        draft={draft}
        offer={offer}
        rows={rows}
        actsAs={app.actsAs.kind}
        podWideKinds={app.podWideKinds}
        names={names}
        live={headline}
        onChange={onDraft}
        isDisabled={busy}
        defaultOpen={defaultOpen}
        marks={{
          can: canChanged ? { text: t("mark.changed"), tone: "primary" } : null,
          in:
            held.kind === "reconsent" && moved.length > 0
              ? { text: t("mark.changed"), tone: "primary" }
              : null,
        }}
      />
      {cannot.length > 0 ? (
        <CantGiveFold
          items={cannot}
          create={
            // Only what no space can hold is fixed by creating one (U5).
            cannot.some((c) => c.why === "noSpace") ? (
              <CreateSpace
                templates={app.templates}
                domain={app.domain}
                onCreated={onSpaceCreated}
              />
            ) : null
          }
        />
      ) : null}
      <div className="flex flex-col gap-1">
        {/* Who its token acts as, in the server's words (`actsAs`). */}
        <p className="text-xs leading-relaxed text-foreground/65">
          {app.actsAs.note}
        </p>
        <div className="flex flex-wrap items-baseline gap-x-1.5 text-xs text-foreground/65">
          <span>{t("facts.sendsBack")}</span>
          <HostName
            host={redirectHost}
            className="text-xs text-foreground/90"
          />
          <span aria-hidden>·</span>
          <span>
            {t("facts.firstSeen")} {formatRelative(registeredAt)}
          </span>
        </div>
      </div>

      {failed !== null ? (
        <Alert
          color="danger"
          role="alert"
          title={t("allowFailed.title", { name: appName })}
          description={
            <span className="flex flex-col gap-0.5">
              <span>{t("allowFailed.hint")}</span>
              {failed ? (
                <span className="break-words text-xs">{failed}</span>
              ) : null}
            </span>
          }
        />
      ) : null}

      <div className="sticky bottom-0 -mx-7 flex flex-col gap-2 bg-content1 px-7 pb-1 pt-2 md:static md:mx-0 md:bg-transparent md:px-0 md:pt-0">
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
            {failed !== null
              ? t("act.tryAgain")
              : confirming
                ? t("act.confirm")
                : t("act.allow")}
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
            {confirming ? t("act.notNow") : t("act.decline")}
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
        {t("revoke.before")}{" "}
        <a
          href="/my-connections"
          className="text-foreground/75 underline underline-offset-2"
        >
          {t("revoke.link")}
        </a>
        {t("revoke.after")}
      </p>
    </>
  );
}

export function ReconsentCallout({
  appName,
  changes,
  draft,
  busy,
  onDraft,
}: {
  appName: string;
  changes: readonly ReconsentChange[];
  draft: ConsentDraft;
  busy: boolean;
  onDraft: (next: ConsentDraft) => void;
}) {
  const t = consentT();
  const id = useId();
  const moved = changes.filter((c) => c.mark !== "new");
  const wider = moved.filter((c) => c.mark === "wider");
  const fresh = changes.filter((c) => c.mark === "new");
  const ink = "text-foreground/80";
  return (
    <section
      aria-labelledby={`${id}-t`}
      data-reconsent
      className="flex gap-2.5 rounded-lg bg-default-100 px-3.5 py-3 ring-1 ring-inset ring-foreground/10"
    >
      <Info className={`mt-0.5 h-4 w-4 shrink-0 ${ink}`} aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {moved.length > 0 ? (
          <>
            {/* The count is what is drawn below (U3). */}
            <p id={`${id}-t`} className="text-sm font-medium text-foreground">
              {t("reconsent.title", { n: moved.length })}
            </p>
            {wider.length > 0 ? (
              <p className={`text-pretty text-xs leading-relaxed ${ink}`}>
                {t("reconsent.body", { name: appName, n: wider.length })}
              </p>
            ) : null}
            <ul className="flex flex-col gap-2">
              {moved.map((c) => {
                const off =
                  c.mark === "wider" && !draft.permissions.has(c.permission);
                return (
                  <li key={c.key} className="flex items-start gap-2">
                    <span
                      aria-hidden
                      className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-content1 text-xs font-medium text-foreground/80 ring-1 ring-inset ring-foreground/15"
                    >
                      {c.mark === "wider" && !off ? "+" : "−"}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="sr-only">
                        {c.mark === "wider"
                          ? t("reconsent.wider")
                          : t("reconsent.narrower")}
                        :{" "}
                      </span>
                      <span
                        className={`text-sm ${off ? `${ink} line-through` : "text-foreground/90"}`}
                      >
                        <strong className="font-medium">{c.what}</strong>
                        {": "}
                        {c.mark === "wider"
                          ? t("reconsent.nowWas", {
                              now: c.now,
                              was: c.was ?? t("reconsent.nowhere"),
                            })
                          : c.now}
                      </span>
                      {off ? (
                        <span className={`text-xs ${ink}`}>
                          {t("reconsent.turnedOff")}
                        </span>
                      ) : null}
                      {c.mark === "wider" ? (
                        <Button
                          size="sm"
                          variant="light"
                          className="-ml-2 min-h-10 self-start px-2 text-foreground/85 underline underline-offset-2"
                          isDisabled={busy}
                          onPress={() =>
                            onDraft(setPermission(draft, c.permission, off))
                          }
                        >
                          {off ? t("reconsent.undo") : c.narrow}
                        </Button>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
        {fresh.length > 0 ? (
          <div className="flex flex-col gap-2" data-new-asks>
            {/* Its own heading, with its own count (U3). */}
            <p
              id={moved.length > 0 ? undefined : `${id}-t`}
              className={`flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.04em] ${ink}`}
            >
              <Sparkles className="h-3 w-3 text-primary" aria-hidden />
              {t("reconsent.new", { n: fresh.length })}
            </p>
            <ul className="flex flex-col gap-2">
              {fresh.map((c) => (
                <li key={c.key} className="flex flex-col gap-0.5">
                  <span className="text-sm text-foreground/90">{c.what}</span>
                  {c.reason ? (
                    <span
                      className={`text-pretty text-xs leading-relaxed ${ink}`}
                    >
                      {/* The developer's words, as text: why it asks. */}
                      <span>{t("reason.prefix")} </span>
                      {c.reason}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            <Switch
              size="sm"
              classNames={{ base: "min-h-10" }}
              isSelected={newAllowed(draft, changes)}
              isDisabled={busy}
              onValueChange={(on) => onDraft(allowNew(draft, changes, on))}
            >
              <span className="text-sm text-foreground/90">
                {t("reconsent.allowNew")}
              </span>
            </Switch>
          </div>
        ) : null}
        {moved.length > 0 ? (
          <p className={`text-xs ${ink}`}>{t("reconsent.rest")}</p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * What it asked for that cannot be given (design A "Can't grant"): folded,
 * each with its reason and a "Not given" mark. Never a disabled toggle. When
 * some of it is missing only a space, the create-a-space offer sits here,
 * next to those items (U5).
 */
function CantGiveFold({
  items,
  create,
}: {
  items: readonly CantGive[];
  create: ReactNode;
}) {
  const t = consentT();
  return (
    <Accordion
      variant="bordered"
      className="px-3"
      itemClasses={{
        title: "text-sm text-foreground/85",
        trigger: "min-h-10 py-2",
        content: "pt-0 pb-3",
      }}
    >
      <AccordionItem
        key="cant"
        aria-label={t("cant.title", { n: items.length })}
        title={t("cant.title", { n: items.length })}
      >
        <ul className="flex flex-col divide-y divide-foreground/10">
          {items.map((i) => (
            <li
              key={i.permission}
              className="flex items-center justify-between gap-3 py-2"
            >
              <span className="flex min-w-0 flex-col">
                <span className="text-sm text-foreground/85">{i.label}</span>
                <span className="text-xs text-foreground/65">{i.reason}</span>
              </span>
              <Chip
                size="sm"
                variant="flat"
                startContent={<Ban className="h-3 w-3" aria-hidden />}
              >
                {t("cant.notGiven")}
              </Chip>
            </li>
          ))}
        </ul>
        {create}
        <p className="pt-1 text-xs text-foreground/65">{t("cant.rest")}</p>
      </AccordionItem>
    </Accordion>
  );
}

function CreateSpace({
  templates,
  domain,
  onCreated,
}: {
  templates: string[];
  domain: string;
  onCreated: () => void;
}) {
  const t = consentT();
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
            setNote(t("create.proposed"));
          } else {
            setNote(t("create.refused"));
          }
        },
        onError: (err) => setNote(err.message),
      }
    );
  };
  if (templates.length === 0) {
    // A state, not an error (rv-ui U9): the screen's neutral hint tone.
    return (
      <p
        role="status"
        className="py-1 text-xs leading-relaxed text-foreground/75"
      >
        {t("create.none")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2 py-2">
      <p className="text-xs text-foreground/80">{t("create.offer")}</p>
      <div className="flex flex-wrap gap-2">
        {templates.map((slug) => (
          <Button
            key={slug}
            size="sm"
            variant="flat"
            className="min-h-10"
            isLoading={ensure.isPending && ensure.variables?.slug === slug}
            isDisabled={ensure.isPending}
            onPress={() => create(slug)}
          >
            {t("create.from", { name: humanizeToken(slug) })}
          </Button>
        ))}
      </div>
      {note && <p className="text-xs text-foreground/75">{note}</p>}
    </div>
  );
}

export function PodAppHeading({
  domain,
  verified,
  clientName,
  podHost,
  identity,
  title,
}: {
  domain: string;
  verified: boolean;
  clientName: string;
  podHost?: string;
  identity?: string;
  title: string;
}) {
  const t = consentT();
  return (
    <>
      <span className="flex flex-wrap items-center gap-2">
        <Chip
          size="sm"
          variant="flat"
          color={verified ? "primary" : "warning"}
          startContent={
            verified ? (
              <ShieldCheck className="h-3 w-3" aria-hidden />
            ) : (
              <ShieldAlert className="h-3 w-3" aria-hidden />
            )
          }
        >
          {verified ? t("tier.verified") : t("tier.unverified")}
        </Chip>
        <HostName host={domain} className="text-sm text-foreground/75" />
      </span>
      <h1 className="font-heading text-xl font-medium leading-tight tracking-tight text-foreground">
        {title}
      </h1>
      <p className="text-sm leading-relaxed text-foreground/65">
        {/* Self-chosen display text, rendered as text only. */}
        {verified ? null : <>{t("who.callsItself", { name: clientName })} </>}
        {podHost && identity
          ? t("who.podAs", { host: podHost, identity })
          : podHost
            ? t("who.pod", { host: podHost })
            : t("who.yourPod")}
      </p>
    </>
  );
}

/** A read that may answer if asked again: a network failure or a 5xx. */
function isTransient(err: unknown): boolean {
  const status = (err as { data?: { httpStatus?: unknown } } | null)?.data
    ?.httpStatus;
  return typeof status !== "number" || status >= 500;
}

export function ConsentSkeleton() {
  const t = consentT();
  // Opacity only (motion-safe): visible on both grounds (P12), still under
  // reduced motion.
  const bar = "rounded-md bg-foreground/15 motion-safe:animate-pulse";
  return (
    <div aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only" role="status">
        {t("loading.label")}
      </span>
      <div className={`h-4 w-4/5 ${bar}`} />
      <div className="flex flex-col divide-y divide-foreground/10 rounded-lg ring-1 ring-inset ring-foreground/10">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3 px-3 py-3">
            <div className={`h-3 w-20 ${bar}`} />
            <div className={`h-4 flex-1 ${bar}`} />
            <div className={`h-8 w-16 !rounded-full ${bar}`} />
          </div>
        ))}
      </div>
      <div className="flex gap-2.5">
        <div className={`h-10 flex-1 !rounded-lg ${bar}`} />
        <div className={`h-10 flex-1 !rounded-lg ${bar}`} />
      </div>
    </div>
  );
}

/**
 * The offer could not be read for a reason that may pass (the pod did not
 * answer): a failed state with the retry inside it, saying nothing was
 * given. A request that is not valid is `Problem` instead: retrying it only
 * repeats the same refusal.
 */
export function ReadFailed({
  onRetry,
  retrying,
  onDecline,
  busy,
}: {
  onRetry: () => void;
  retrying: boolean;
  onDecline: () => void;
  busy: boolean;
}) {
  const t = consentT();
  return (
    <div className="flex flex-col items-stretch gap-3">
      <Alert
        color="danger"
        role="alert"
        title={t("readFailed.title")}
        description={t("readFailed.hint")}
        endContent={
          <Button
            size="sm"
            variant="flat"
            className="min-h-10"
            isLoading={retrying}
            onPress={onRetry}
          >
            {t("act.tryAgain")}
          </Button>
        }
      />
      <Button
        size="sm"
        variant="light"
        className="min-h-10 self-center"
        isDisabled={busy}
        onPress={onDecline}
      >
        {t("readFailed.decline")}
      </Button>
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

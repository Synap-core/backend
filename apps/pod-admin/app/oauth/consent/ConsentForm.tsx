"use client";

import { useCallback, useEffect, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@synap-core/api-types";
import { ReceiverShell } from "../../_lib/receiver-shell";
import {
  Button,
  CardBody,
  CardHeader,
  Checkbox,
  Chip,
  Spinner,
} from "@heroui/react";
import {
  Check,
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
  initialSelection,
  isTicked,
  permissionLabel,
  toApproved,
  toggle,
  withoutSpace,
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
  | { kind: "reconfirming" };

export function ConsentForm({
  params,
  podHost,
  identity,
}: {
  params: ConsentParams;
  podHost?: string;
  identity?: string;
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

  // A pod app (CIMD client): the person narrows what it may touch, per space.
  const app = context.data?.app ?? null;
  const [selection, setSelection] = useState<Selection>(new Set());
  useEffect(() => {
    if (app) setSelection(initialSelection(app.permissions, app.approved));
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
    <ReceiverShell podHost={podHost} identity={identity} width="sm">
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
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground/65">
            {firstParty ? "Sign-in request" : "Connection request"}
          </p>
          {firstParty ? (
            <>
              <h1 className="font-heading text-[22px] font-medium leading-tight tracking-tight text-foreground">
                {firstParty.reconfirm
                  ? "Confirm it's you"
                  : `Sign in to ${firstParty.name}`}
              </h1>
              <p className="text-[13px] leading-relaxed text-foreground/65">
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
              <h1 className="break-all font-mono text-[20px] font-medium leading-tight text-foreground">
                {app.domain}
              </h1>
              <p className="text-[13px] leading-relaxed text-foreground/65">
                {/* Self-chosen display text, rendered as text only. */}
                Calls itself &ldquo;{context.data?.clientName}&rdquo; and wants
                to connect to your pod{podHost ? ` ${podHost}` : ""}
                {identity ? ` as ${identity}` : ""}.
              </p>
            </>
          ) : (
            <>
              <h1 className="font-heading text-[22px] font-medium leading-tight tracking-tight text-foreground">
                {/* Registered by an unauthenticated DCR call — attacker-choosable
                      display text. React escapes it; it is NEVER rendered as markup.
                      An app sign-in's name is its owner's app name on this pod. */}
                {appSignIn ? "Sign in to" : "Connect"}{" "}
                {context.data?.clientName ?? "an application"}
              </h1>
              <p className="text-[13px] leading-relaxed text-foreground/65">
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
                hint={`Close this tab and start again from ${requesterName(params.clientId)}. A fresh request carries valid details.`}
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
                  onSpaceCreated={() => void context.refetch()}
                  busy={busy}
                  step={step}
                  canAllow={approved.length > 0}
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
                      <span className="text-[13px] text-foreground/60">
                        Sends you back to
                      </span>
                      <span className="break-all font-mono text-[13px] text-foreground/90">
                        {context.data.redirectHost}
                      </span>
                    </div>
                    {appSignIn ? (
                      <div className="flex flex-col gap-2 pt-1.5">
                        <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/60">
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
                              <span className="text-[12.5px] leading-relaxed text-foreground/75">
                                <span className="font-medium text-foreground/90">
                                  {space.name}
                                </span>
                                : {space.can}
                              </span>
                            </li>
                          ))}
                        </ul>
                        <p className="text-[12.5px] leading-relaxed text-foreground/75">
                          {appSignIn.cannot}
                        </p>
                        <p className="text-[12.5px] leading-relaxed text-foreground/65">
                          {appSignIn.note}
                        </p>
                      </div>
                    ) : (
                      <div className="pt-1.5">
                        <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/60">
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
                              <span className="text-[12.5px] leading-relaxed text-foreground/75">
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
                      Deny
                    </Button>
                  </div>

                  <p className="text-center text-[11.5px] leading-relaxed text-foreground/60">
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
                  className="flex h-12 w-12 items-center justify-center rounded-full bg-foreground/[0.06] text-foreground/60 ring-1 ring-inset ring-foreground/15"
                >
                  <X className="h-6 w-6" strokeWidth={2.2} />
                </span>
                <div className="flex flex-col gap-1">
                  <p className="text-[14px] font-medium text-foreground">
                    Denied
                  </p>
                  <p className="max-w-[18rem] text-[12.5px] text-foreground/65">
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
        <span className="text-[13.5px] font-medium text-foreground">
          Confirming it&apos;s you…
        </span>
        <span className="text-[12.5px] text-foreground/65">
          Taking you to sign in again. You come back here after.
        </span>
      </div>
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
        <p className="flex items-center gap-1.5 text-[13px] font-medium text-foreground/85">
          <Glyph className="h-3.5 w-3.5" aria-hidden />
          {reconfirm
            ? `${name} is already signed in.`
            : `${name} will act as you.`}
        </p>
        <p className="text-[12.5px] leading-relaxed text-foreground/75">
          {reconfirm
            ? `It asks before it changes a key, a connection or a secret. Only continue if you just asked ${name} to do that.`
            : `It can do what you can do in Synap. Only continue if you just opened ${name} and asked it to sign in.`}
        </p>
        <div className="flex flex-col gap-1 pt-0.5">
          <span className="text-[13px] text-foreground/60">
            Sends you back to
          </span>
          <span
            className={
              onComputer
                ? "text-[13px] text-foreground/90"
                : "break-all font-mono text-[13px] text-foreground/90"
            }
          >
            {onComputer ? `This computer (${redirectHost})` : redirectHost}
          </span>
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
      <p className="text-center text-[11.5px] leading-relaxed text-foreground/60">
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
 * A pod app's consent (spec 17 §9.1): its domain is the headline (above), and
 * the person picks, per permission, the spaces it may act in — only from what
 * the pod offers, so the screen can narrow and never widen.
 */
function AppConsent({
  app,
  registeredAt,
  redirectHost,
  selection,
  onToggle,
  onSpaceCreated,
  busy,
  step,
  canAllow,
  onDecide,
}: {
  app: ConsentApp;
  registeredAt: Date | string;
  redirectHost: string;
  selection: Selection;
  onToggle: (permission: string, workspaceId: string) => void;
  onSpaceCreated: () => void;
  busy: boolean;
  step: Step;
  canAllow: boolean;
  onDecide: (approve: boolean) => void;
}) {
  const missing = withoutSpace(app.permissions);
  return (
    <>
      <div className="flex flex-col gap-3 rounded-lg bg-foreground/[0.03] px-4 py-3 ring-1 ring-inset ring-foreground/10">
        <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/60">
          <ShieldCheck className="h-3 w-3" aria-hidden /> It asks to
        </p>
        <ul className="flex flex-col gap-3">
          {app.permissions.map((p) => (
            <li key={p.permission} className="flex flex-col gap-1.5">
              <span className="text-[13px] text-foreground/85">
                {permissionLabel(p.permission)}{" "}
                <span className="font-mono text-[11px] text-foreground/50">
                  {p.permission}
                </span>
              </span>
              {p.workspaces.length === 0 ? (
                <span className="text-[12px] text-foreground/60">
                  You have no space where you can give it this.
                </span>
              ) : (
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {p.workspaces.map((w) => (
                    <Checkbox
                      key={w.workspaceId}
                      size="sm"
                      isSelected={isTicked(
                        selection,
                        p.permission,
                        w.workspaceId
                      )}
                      isDisabled={busy}
                      onValueChange={() =>
                        onToggle(p.permission, w.workspaceId)
                      }
                    >
                      {w.workspaceName}
                    </Checkbox>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
        {app.ignoredScopes.length > 0 && (
          <p className="text-[12px] text-foreground/60">
            It also asked for {app.ignoredScopes.join(", ")}, which apps are not
            given.
          </p>
        )}
        <p className="text-[12px] leading-relaxed text-foreground/65">
          Every change it makes is sent to you for review first. It can never
          see other spaces, approve its own changes, or create keys.
        </p>
        <div className="flex flex-col gap-1 pt-0.5">
          <span className="text-[13px] text-foreground/60">
            Sends you back to
          </span>
          <span className="break-all font-mono text-[13px] text-foreground/90">
            {redirectHost}
          </span>
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

      <div className="flex gap-2.5">
        <Button
          color="primary"
          radius="md"
          size="md"
          className="flex-1 font-medium"
          isDisabled={busy || !canAllow}
          isLoading={busy && step.kind === "working" && step.approve}
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
          Deny
        </Button>
      </div>
      <p className="text-center text-[11.5px] leading-relaxed text-foreground/60">
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
    return (
      <Problem
        title="No space to give it"
        message="You have no space where you can give this app what it asks for."
        hint="Create a space in Synap (or ask for edit rights in one), then reload this page."
      />
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg px-4 py-3 ring-1 ring-inset ring-foreground/10">
      <p className="text-[13px] text-foreground/80">
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
      {note && <p className="text-[12px] text-foreground/65">{note}</p>}
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
        <p className="text-[13px] font-medium text-foreground">{title}</p>
        <p className="mt-0.5 break-words text-[12.5px] text-foreground/65">
          {message}
        </p>
        {hint && (
          <p className="mt-1.5 text-[12.5px] text-foreground/60">{hint}</p>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[13px]">
      <span className="shrink-0 text-foreground/60">{label}</span>
      <span className="min-w-0 truncate text-foreground/85">{value}</span>
    </div>
  );
}

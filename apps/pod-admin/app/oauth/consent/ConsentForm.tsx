"use client";

import { useCallback, useState } from "react";
import { ReceiverShell } from "../../_lib/receiver-shell";
import { Button, CardBody, CardHeader, Spinner } from "@heroui/react";
import { Check, Plug, ShieldCheck, X } from "lucide-react";

import { trpc } from "../../../lib/trpc";

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
}

type Step =
  | { kind: "idle" }
  | { kind: "working"; approve: boolean }
  | { kind: "denied" }
  | { kind: "error"; message: string };

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

  const act = useCallback(
    (approve: boolean) => {
      setStep({ kind: "working", approve });
      decide.mutate(
        { ...params, approve },
        {
          onSuccess: ({ redirectTo }) => {
            // Built server-side from the client's REGISTERED redirect_uri, so
            // this is never an attacker-chosen destination. Top-level navigate
            // (not router.push) — the target is off-origin.
            window.location.href = redirectTo;
          },
          onError: (err) => {
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
    [decide, params]
  );

  const busy = step.kind === "working";

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
            Connection request
          </p>
          <h1 className="font-heading text-[22px] font-medium leading-tight tracking-tight text-foreground">
            {/* Registered by an unauthenticated DCR call — attacker-choosable
                  display text. React escapes it; it is NEVER rendered as markup. */}
            Connect {context.data?.clientName ?? "an application"}
          </h1>
          <p className="text-[13px] leading-relaxed text-foreground/65">
            It is asking to connect to your Synap pod.
          </p>
        </div>
      </CardHeader>

      <CardBody className="flex flex-col gap-5 px-7 pb-7 pt-5">
        {context.isLoading && (
          <div className="flex items-center justify-center py-10">
            <Spinner size="sm" />
          </div>
        )}

        {context.isError && (
          <Problem
            title="This authorization request isn't valid"
            message={context.error.message}
            hint="Close this tab and start the connection again from Claude — a fresh request will carry valid details."
          />
        )}

        {context.data && step.kind !== "denied" && step.kind !== "error" && (
          <>
            <div className="flex flex-col gap-2.5 rounded-lg bg-foreground/[0.03] px-4 py-3 ring-1 ring-inset ring-foreground/10">
              <Row label="Application" value={context.data.clientName} />
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
              <div className="pt-1.5">
                <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/60">
                  <ShieldCheck className="h-3 w-3" aria-hidden /> It will be
                  able to
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
                My connections
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
              <p className="text-[14px] font-medium text-foreground">Denied</p>
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
      </CardBody>
    </ReceiverShell>
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

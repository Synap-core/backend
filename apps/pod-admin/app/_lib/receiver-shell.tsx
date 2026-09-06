"use client";

/**
 * `ReceiverShell` — the frame for every page a link ARRIVES at.
 *
 * pod-admin has two halves. The `(admin)` tabs are an operator console, and
 * they have chrome: a header, a tab strip, an identity. The other half — the
 * routes people reach from an email, a CLI, a Discord unfurl, an agent, or the
 * backend's `{pod}/open/*` bounce — had no chrome at all. `app/(admin)/layout.tsx`
 * is what applies the console chrome, and none of these routes live under it.
 *
 * That half is the higher-stakes one. It is where a person who has never seen
 * Synap decides whether to approve a proposal, accept an invite, or authorise
 * an agent. Rendering that decision on an unbranded page with no indication of
 * which pod they are looking at, who they are signed in as, or where to go
 * afterwards is how a legitimate request reads as a phishing attempt.
 *
 * `/proposal/[id]` already had the right shape — a centered card, a terminal
 * outcome, and an open-in-app footer. This is that shape, extracted, so a
 * person who lands on two of these recognises the second one.
 *
 * Deliberately NOT provided: navigation into the `(admin)` console. Most people
 * arriving here are not pod admins, and offering them a door they will be
 * bounced out of by `proxy.ts` is worse than offering none.
 */

import { Card } from "@heroui/react";
import { createContext, useContext, type ReactNode } from "react";

/**
 * Pod identity for a receiver page, provided once per route.
 *
 * `/open` renders its card from three different components, all of which need
 * the same header. Threading two props through all of them would mean the next
 * component someone adds silently renders a headerless card — the failure this
 * shell exists to prevent. A context makes the identity impossible to forget.
 */
interface ReceiverIdentity {
  podHost?: string;
  identity?: string;
}

const ReceiverIdentityContext = createContext<ReceiverIdentity>({});

export function ReceiverIdentityProvider({
  podHost,
  identity,
  children,
}: ReceiverIdentity & { children: ReactNode }) {
  return (
    <ReceiverIdentityContext.Provider value={{ podHost, identity }}>
      {children}
    </ReceiverIdentityContext.Provider>
  );
}

interface ReceiverShellProps {
  /** The pod this decision concerns. Anchors the page against phishing. */
  podHost?: string;
  /** Who the reader is signed in as, when known. */
  identity?: string;
  children: ReactNode;
  /** Exits and secondary affordances, rendered under the card. */
  footer?: ReactNode;
}

export function ReceiverShell({
  podHost,
  identity,
  children,
  footer,
}: ReceiverShellProps) {
  // Explicit props win; otherwise fall back to the route-level provider.
  const inherited = useContext(ReceiverIdentityContext);
  const host = podHost ?? inherited.podHost;
  const who = identity ?? inherited.identity;
  return (
    <main className="flex min-h-screen flex-col items-center px-6 py-12 sm:py-16">
      <div className="flex w-full max-w-2xl flex-col gap-4">
        <ReceiverHeader podHost={host} identity={who} />

        <Card
          radius="lg"
          shadow="none"
          className="bg-foreground/[0.04] ring-1 ring-inset ring-foreground/10"
        >
          {children}
        </Card>

        {footer && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1">
            {footer}
          </div>
        )}
      </div>
    </main>
  );
}

/**
 * The one line that says WHERE the reader is.
 *
 * Rendered even when both values are unknown — an empty brand row still tells
 * the reader this is a Synap page, which is the minimum a decision surface
 * reached from an email owes them.
 */
function ReceiverHeader({
  podHost,
  identity,
}: {
  podHost?: string;
  identity?: string;
}) {
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
      <span className="flex items-center gap-2">
        <span
          aria-hidden
          className="flex h-5 w-5 items-center justify-center rounded-md bg-primary"
        >
          <span className="text-[9px] font-semibold text-white/95">S</span>
        </span>
        <span className="text-[13px] font-medium tracking-tight text-foreground">
          Synap
        </span>
      </span>

      {podHost && (
        <span className="font-mono text-[12px] text-foreground/75">
          {podHost}
        </span>
      )}

      {identity && (
        <span className="ml-auto truncate text-[12px] text-foreground/60">
          Signed in as <span className="text-foreground/80">{identity}</span>
        </span>
      )}
    </header>
  );
}

/**
 * /proposal/[id] — the web review surface for a single governed proposal.
 *
 * This is the MAIN view an AI-sent review link lands on: the pod's `/open/<id>`
 * deep-link (served by the Hono API) now 302s a `proposal` here instead of
 * bouncing straight into the Electron app — so accept / reject / modify happen
 * on the web, with "open in the desktop app" available as a sub-action.
 *
 * Auth: middleware enforces a valid Kratos session (no pod_admin role required —
 * a proposal reviewer is usually a workspace editor; `proposals.get`/`.approve`
 * re-check editor role server-side). `/proposal/*` is in the `isSelfService`
 * allowlist in `proxy.ts`, so an unauthenticated visitor is bounced to
 * `/login?return=/proposal/<id>` and comes straight back.
 *
 * v1 renders a compact, stack-native (HeroUI) view. The richer per-kind diff
 * rendering (the shared `@synap-core/proposal-ui` renderer) is a later upgrade
 * once those packages are published to the registry pod-admin consumes.
 */

import { headers } from "next/headers";
import { ProposalReview } from "./ProposalReview";

export const dynamic = "force-dynamic";

interface ProposalPageProps {
  params: Promise<{ id: string }>;
}

export default async function ProposalPage({ params }: ProposalPageProps) {
  const { id } = await params;
  // Same header plumbing the (admin) layout uses. A decision surface reached
  // from an email has to say WHICH pod it speaks for and who the reader is
  // signed in as — without that, a legitimate approval request is
  // indistinguishable from a phishing page.
  const h = await headers();
  return (
    <ProposalReview
      proposalId={id}
      podHost={h.get("host") ?? undefined}
      identity={h.get("x-pod-admin-email") ?? undefined}
    />
  );
}

/**
 * /open/:type/:id — the signed-in web page for one object (`HOST_TYPES`), or a
 * named "opens in the app" card.
 *
 * Auth: middleware enforces a valid Kratos session (no pod_admin role required —
 * every read door is user-floored and re-checks access server-side). `/open/*`
 * is in the `isSelfService` allowlist in `proxy.ts`, so an unauthenticated
 * visitor is bounced to `/login?return=/open/<type>/<id>` and comes back.
 *
 * Mostly read-only: the acts are the de-escalating ones (pause a rule, cancel
 * a session or a run, disconnect an agent), a session's owner-only run again /
 * revert, archiving a template, and turning a capability's verbs on — each
 * re-gated by its own door. Authoring lives in the Synap app
 * (`synap://open/{type}/{id}`). Known bounce kinds (channel, document, …) never
 * pretend to render here.
 *
 * `?flowType=` addresses a run (`{flowType, id}`); the public route forwards
 * it and the run page falls back to the resolver without it.
 */

import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { podAdminRole } from "../../../../lib/kratos";
import { OpenSurface } from "./OpenSurface";
import { openDocumentTitle, parseOpenParams } from "../../open-params";

export const dynamic = "force-dynamic";

interface OpenPageProps {
  params: Promise<{ type: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Kinds whose page offers a pod admin something more (a space's console page,
 * a template's space named from every space, pod-wide verbs to turn on,
 * removing an agent). `/open` is self-service, so
 * the proxy does not ask the role here; these pages ask it themselves. It only
 * shapes what is OFFERED — every act re-checks the role server-side.
 */
const ROLE_AWARE_KINDS: ReadonlySet<string> = new Set([
  "workspace",
  "playbook",
  "capability",
  "agent",
]);

export async function generateMetadata({
  params,
}: OpenPageProps): Promise<Metadata> {
  const { type, id } = await params;
  return { title: openDocumentTitle(parseOpenParams(type, id)) };
}

export default async function OpenPage({
  params,
  searchParams,
}: OpenPageProps) {
  const { type, id } = await params;
  const { flowType } = await searchParams;
  const parsed = parseOpenParams(type, id);
  // The review surface already lives at /proposal/:id — don't show a bounce
  // card if a typed /open/proposal link lands here.
  if (parsed.status === "bounce" && parsed.type === "proposal") {
    redirect(`/proposal/${parsed.id}`);
  }
  // Same identity plumbing as /proposal: an object link arriving from an
  // email or a CLI must say which pod it belongs to before it shows content.
  const h = await headers();
  // An unanswered role question offers the member's page, never more.
  const viewerIsPodAdmin =
    parsed.status !== "not-found" &&
    ROLE_AWARE_KINDS.has(parsed.type) &&
    (await podAdminRole(h)) === "admin";
  return (
    <OpenSurface
      parsed={parsed}
      flowType={typeof flowType === "string" ? flowType : undefined}
      viewerIsPodAdmin={viewerIsPodAdmin}
      podHost={h.get("host") ?? undefined}
      identity={h.get("x-pod-admin-email") ?? undefined}
    />
  );
}

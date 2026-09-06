/**
 * /open/:type/:id — signed-in compact read card for one entity or view.
 *
 * Auth: middleware enforces a valid Kratos session (no pod_admin role required —
 * `entities.get` / `views.get` re-check access server-side). `/open/*` is in the
 * `isSelfService` allowlist in `proxy.ts`, so an unauthenticated visitor is
 * bounced to `/login?return=/open/<type>/<id>` and comes straight back.
 *
 * This is read-only. The rich renderer lives in the Synap app
 * (`synap://open/{type}/{id}`). Known bounce kinds (channel, document, …)
 * never pretend to render here.
 */

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { OpenSurface } from "./OpenSurface";
import { openDocumentTitle, parseOpenParams } from "../../open-params";

import { headers } from "next/headers";

export const dynamic = "force-dynamic";

interface OpenPageProps {
  params: Promise<{ type: string; id: string }>;
}

export async function generateMetadata({
  params,
}: OpenPageProps): Promise<Metadata> {
  const { type, id } = await params;
  return { title: openDocumentTitle(parseOpenParams(type, id)) };
}

export default async function OpenPage({ params }: OpenPageProps) {
  const { type, id } = await params;
  const parsed = parseOpenParams(type, id);
  // The review surface already lives at /proposal/:id — don't show a bounce
  // card if a typed /open/proposal link lands here.
  if (parsed.status === "bounce" && parsed.type === "proposal") {
    redirect(`/proposal/${parsed.id}`);
  }
  // Same identity plumbing as /proposal: an object link arriving from an
  // email or a CLI must say which pod it belongs to before it shows content.
  const h = await headers();
  return (
    <OpenSurface
      parsed={parsed}
      podHost={h.get("host") ?? undefined}
      identity={h.get("x-pod-admin-email") ?? undefined}
    />
  );
}

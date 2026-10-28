/**
 * Start journey proxy — `POST /api/start`.
 *
 * The `/start` pages write through the pod's onboarding doors as the signed-in
 * person, forwarding the session cookie (the browser cannot call the pod's tRPC
 * origin from here). Raw pod caller, not the typed client: `onboarding.*`'s
 * start procedures are newer than the generated `@synap-core/api-types`
 * (`lib/pod-trpc.ts`).
 *
 * An allowlist, never a passthrough:
 *   - `{ action: "intent", slug, source }` → `onboarding.recordStartStep`
 *     `{ step: "intent", patch: { slug, source } }` (S1 Continue);
 *   - `{ action: "skip" }` → `onboarding.dismissJourney` on the pod lens
 *     (S1 "Skip setup for now").
 * The pod re-checks everything (pod admin, a listed start, a cloud answer that
 * really says what `source: "cloud"` claims).
 */

import { apiSessionDenial } from "../../../lib/kratos";
import { callPodMutation } from "../../../lib/pod-trpc";

export const dynamic = "force-dynamic";

const POD_LENS = { kind: "pod" } as const;

export async function POST(req: Request) {
  const denied = await apiSessionDenial(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as {
    action?: unknown;
    slug?: unknown;
    source?: unknown;
  } | null;

  let procedure: string;
  let input: unknown;
  if (body?.action === "intent") {
    if (typeof body.slug !== "string" || !body.slug.trim()) {
      return Response.json({ error: "slug is required" }, { status: 400 });
    }
    if (body.source !== "cloud" && body.source !== "here") {
      return Response.json(
        { error: "source must be cloud or here" },
        { status: 400 }
      );
    }
    procedure = "onboarding.recordStartStep";
    input = { step: "intent", patch: { slug: body.slug, source: body.source } };
  } else if (body?.action === "skip") {
    procedure = "onboarding.dismissJourney";
    input = { lens: POD_LENS };
  } else {
    return Response.json(
      { error: "action must be intent or skip" },
      { status: 400 }
    );
  }

  const res = await callPodMutation<unknown>(procedure, input, req.headers);
  if (!res.ok) {
    return Response.json({ error: res.message }, { status: res.status });
  }
  return Response.json({ ok: true });
}

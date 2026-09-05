/**
 * Install door — `POST /api/marketplace/install`.
 *
 * A THIN FORWARDER to the pod's HUMAN door, not an install engine:
 *
 *   workspaces.preflightFromDefinition  — write-free preview (shared core)
 *   workspaces.createFromDefinition     — the governed create
 *
 * Both are tRPC, which authenticates the operator's Kratos cookie. `/api/hub/*`
 * is the AGENT protocol and reads `Authorization: Bearer` / `X-Session-Token`
 * only, so a browser session can never reach it — see `lib/pod-trpc.ts`.
 *
 * Preflight and create run the SAME shared core
 * (`preflightWorkspaceFromDefinition` / `createWorkspaceFromDefinition` in
 * `@synap/database`), so the preview describes what the create will actually
 * do. Until this change the human door had only the create half; the preview
 * half existed on the agent door alone.
 *
 * WORKSPACE PACKAGES ONLY, and that is a real limit rather than a gap to paper
 * over. A `capability` package's definition is `{profiles: [], capability:{…}}`
 * and a `view` pack's is `{views:[…], profiles:[]}` — neither is
 * workspace-from-definition shaped. Running the workspace preflight over one
 * would return a confident, all-empty, `ok:true` report describing an install
 * it knows nothing about, and those kinds are applied by a different applier
 * (`applyMarketInstall`) entirely. The caller is told the kind is not
 * installable here; a wrong preview is worse than an absent one.
 *
 * The definition is resolved HERE, server-side, from the Control Plane by slug,
 * so a client cannot hand the pod a definition no published package contains.
 */

import { whoamiFromCookie } from "../../../../lib/kratos";
import { controlPlaneUrl } from "../../../../lib/marketplace";
import { callPodMutation } from "../../../../lib/pod-trpc";

export const dynamic = "force-dynamic";

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export async function POST(req: Request) {
  const cookie = req.headers.get("cookie") ?? "";
  const identity = await whoamiFromCookie(cookie);
  if (!identity) {
    return Response.json({ error: "Not signed in" }, { status: 401 });
  }

  let body: { slug?: unknown; step?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const slug = typeof body.slug === "string" ? body.slug : "";
  if (!SLUG_RE.test(slug)) {
    return Response.json({ error: "Invalid package slug" }, { status: 400 });
  }
  const step = body.step === "apply" ? "apply" : "preflight";

  // ── 1. Resolve the published definition from the ONE catalog ─────────────
  let pkg: {
    slug: string;
    version: string;
    displayName: string;
    category: string;
    icon: string | null;
    definition: Record<string, unknown>;
  };
  try {
    const res = await fetch(
      `${controlPlaneUrl()}/api/packages/${encodeURIComponent(slug)}`,
      { headers: { Accept: "application/json" }, cache: "no-store" }
    );
    if (res.status === 404) {
      return Response.json({ error: "Package not found" }, { status: 404 });
    }
    if (!res.ok) {
      return Response.json(
        { error: `Catalog returned ${res.status}.` },
        { status: 502 }
      );
    }
    pkg = ((await res.json()) as { package: typeof pkg }).package;
  } catch {
    return Response.json(
      { error: "Could not reach the Synap catalog." },
      { status: 502 }
    );
  }

  if (pkg.category !== "workspace") {
    return Response.json(
      {
        error:
          `Pod Admin can't preview or install a ${pkg.category} package yet — ` +
          "only workspace packages, whose definition this pod can check " +
          "against your data before writing anything.",
        reason: "kind_not_installable_here",
      },
      { status: 501 }
    );
  }

  // `_meta.slug` is what makes the create idempotent (it becomes the
  // provisioning proposalId) and stamps package provenance on the workspace.
  const definition = { ...pkg.definition };

  if (step === "preflight") {
    const result = await callPodMutation<unknown>(
      "workspaces.preflightFromDefinition",
      { definition },
      cookie
    );
    if (!result.ok) {
      return Response.json(
        { error: result.message, code: result.code },
        { status: result.status }
      );
    }
    return Response.json(result.data);
  }

  const result = await callPodMutation<unknown>(
    "workspaces.createFromDefinition",
    {
      definition,
      workspaceName: definition.workspaceName ?? pkg.displayName,
      proposalId: pkg.slug,
      templateId: pkg.slug,
      packageSlug: pkg.slug,
      packageVersion: pkg.version,
    },
    cookie
  );
  if (!result.ok) {
    return Response.json(
      { error: result.message, code: result.code },
      { status: result.status }
    );
  }
  return Response.json(result.data);
}

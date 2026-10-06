/**
 * The version a pod stamps for a package it applied — DERIVED from the
 * definition it actually applied, never taken from the caller's label.
 *
 * INCIDENT (2026-10-06): `synap market install content-os --onto <ws>` sent the
 * CLI's frozen 0.11 bundle (no `primarySurface`) labelled with the catalog
 * row's `_meta.version: "h-448ffcae9220"`. `/packages/apply` stamped that label
 * into `settings.packageVersion`, so `template_health` reported a stale layout
 * as up to date — and a re-install would have short-circuited on the stamp.
 * A marker may only assert what was actually applied (backend-rules,
 * "Template→installed convergence").
 *
 * RULE — the SAME one the Control Plane mints catalog versions with
 * (`synap-control-plane-api` `definitionVersion`): `h-` + the first 12 hex of
 * sha256 over the key-sorted JSON of the definition, minus `contentHash` and
 * `sourcePackage` (provenance, not content). The CP stores definitions WITHOUT
 * `_meta` (its normalizer hoists it to row columns), so `_meta` — where callers
 * put their version label — is excluded here too, as are the request-only
 * fields of `POST /packages/apply`. Consequence:
 *   • the catalog's own definition, sent verbatim, stamps the catalog version
 *     (`template_health`: up to date — and it is);
 *   • any other definition (a stale bundle, a hand edit) stamps a different
 *     `h-` value, so `template_health` reports drift and a later install of the
 *     catalog definition reconciles instead of short-circuiting.
 * Parity with the CP is pinned by ONE literal shared with
 * `synap-control-plane-api/src/seeds/publish-package-core.provenance.test.ts`.
 *
 * NOT COVERED (honest): a request-only field added to `PackageApplySchema` but
 * not to `APPLY_REQUEST_FIELDS` is hashed as content. That can only produce a
 * false DRIFT (an honest re-apply), never a false "up to date".
 */
import { createHash } from "node:crypto";
import { stableStringify } from "../utils/stable-stringify.js";

/** Fields of the apply request that steer the install but are not template content. */
export const APPLY_REQUEST_FIELDS = [
  "targetWorkspaceId",
  "agentUserId",
  "instanceName",
  "force",
  "projectId",
  "projectName",
] as const;

/** Never part of the content hash: the caller's label, the CP's own stamps. */
const NON_CONTENT_FIELDS = ["_meta", "contentHash", "sourcePackage"] as const;

export function appliedPackageVersion(
  rawDefinition: Record<string, unknown>
): string {
  const content: Record<string, unknown> = { ...rawDefinition };
  for (const key of [...APPLY_REQUEST_FIELDS, ...NON_CONTENT_FIELDS])
    delete content[key];
  const hex = createHash("sha256")
    .update(stableStringify(content))
    .digest("hex");
  return `h-${hex.slice(0, 12)}`;
}

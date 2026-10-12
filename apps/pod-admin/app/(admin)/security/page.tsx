"use client";

/**
 * Pod security — who the pod trusts, and where its secrets live.
 *
 * Two sections, the active one in `?section=` so deep links land on it (the
 * old `/trust-keys?section=issuers&focus=<id>` redirects here with its query):
 *   1. Trusted issuers — who may SIGN JWTs this pod verifies (crypto plane),
 *      plus the connection-broker trust panel. Orthogonal to Apps (browser
 *      origins). Pending issuers are decided in Review, not here.
 *   2. Secrets — where pod-level and per-user secrets live.
 *
 * API keys moved to their own page, `/keys`.
 */

import { Suspense } from "react";
import { PageHeader } from "../components/page-header";
import { UrlTabs } from "../components/url-tabs";
import { IssuersSection } from "./_lib/issuers-section";
import { SecretsSection } from "./_lib/secrets-section";

const TITLE = "Pod security";
const DESCRIPTION =
  "Who this pod trusts to sign in its users, and where its secrets are kept.";

function SecurityInner() {
  return (
    <div className="px-4 py-6 sm:px-6 max-w-[1400px]">
      <PageHeader title={TITLE} description={DESCRIPTION} />

      <UrlTabs
        param="section"
        ariaLabel="Pod security sections"
        tabs={[
          {
            key: "issuers",
            label: "Trusted issuers",
            content: <IssuersSection />,
          },
          {
            key: "secrets",
            label: "Secrets",
            content: <SecretsSection />,
          },
        ]}
      />
    </div>
  );
}

export default function SecurityPage() {
  // Next 16's `useSearchParams` requires a Suspense boundary.
  return (
    <Suspense fallback={<SecurityFallback />}>
      <SecurityInner />
    </Suspense>
  );
}

function SecurityFallback() {
  return (
    <div className="px-4 py-6 sm:px-6 max-w-[1400px]">
      <PageHeader title={TITLE} description={DESCRIPTION} />
      <div className="h-9 w-full max-w-md rounded-md bg-foreground/[0.05] shimmer-pulse" />
    </div>
  );
}

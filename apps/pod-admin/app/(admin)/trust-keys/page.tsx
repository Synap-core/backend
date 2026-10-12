"use client";

/**
 * Trust & Keys tab.
 *
 * Combines TrustedIssuers + ApiKeys + Secrets/Vault from the legacy
 * admin-ui (Phase C of the pod-admin port).  Three sub-tabs render in
 * a HeroUI `Tabs` strip; the active sub-tab is encoded in the URL
 * (`?section=...`) so deep links from Overview alerts (`/trust-keys?focus=...`)
 * land in the right place.
 *
 * Sub-tabs:
 *   1. Trusted issuers — who may *sign* JWTs this Pod verifies (crypto plane).
 *      Orthogonal to App origins (browser origin CORS allowlist).
 *   2. API keys        — system (read-only) + operator (CRUD) keys
 *   3. Secrets vault   — pointer to env-managed + Studio user vaults
 */

import { Suspense } from "react";
import { PageHeader } from "../components/page-header";
import { UrlTabs } from "../components/url-tabs";
import { ApiKeysSection } from "./_lib/api-keys-section";
import { ComputerKeyLifetime } from "./_lib/computer-key-lifetime";
import { IssuersSection } from "./_lib/issuers-section";
import { SecretsSection } from "./_lib/secrets-section";

const TITLE = "Trust & Keys";
const DESCRIPTION = "Issuers, tokens, and secrets the pod trusts.";

function TrustKeysInner() {
  return (
    <div className="px-6 py-6 max-w-[1400px]">
      <PageHeader title={TITLE} description={DESCRIPTION} />

      <UrlTabs
        param="section"
        ariaLabel="Trust & Keys sections"
        tabs={[
          {
            key: "issuers",
            label: "Trusted issuers",
            content: <IssuersSection />,
          },
          {
            key: "api-keys",
            label: "API keys",
            content: (
              <div className="flex flex-col gap-5">
                <ComputerKeyLifetime />
                <ApiKeysSection />
              </div>
            ),
          },
          {
            key: "secrets",
            label: "Secrets vault",
            content: <SecretsSection />,
          },
        ]}
      />
    </div>
  );
}

export default function TrustKeysPage() {
  // Next 16's `useSearchParams` requires a Suspense boundary.
  return (
    <Suspense fallback={<TrustKeysFallback />}>
      <TrustKeysInner />
    </Suspense>
  );
}

function TrustKeysFallback() {
  return (
    <div className="px-6 py-6 max-w-[1400px]">
      <PageHeader title={TITLE} description={DESCRIPTION} />
      <div className="h-9 w-full max-w-md rounded-md bg-foreground/[0.05] shimmer-pulse" />
    </div>
  );
}

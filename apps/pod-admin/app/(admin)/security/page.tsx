"use client";

/**
 * Pod security — who the pod trusts, and where its secrets live.
 *
 * First the pod's one switch for people: "Approvals need you in person"
 * (the proof-of-presence mode, W3 slice 3), then what asks for a passkey on
 * this pod and your own passkeys (W5: the ONE passkeys card, shared with
 * settings Security), above the sections they govern.
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
import { PageFallback, PageHeader, PageShell } from "../components/page-header";
import { UrlTabs } from "../components/url-tabs";
import { IssuersSection } from "./_lib/issuers-section";
import { PasskeysCard } from "../../_lib/passkeys/passkeys-card";
import { PresenceModeCard } from "./_lib/presence-mode-card";
import { SensitivityCard } from "./_lib/sensitivity-card";
import { SecretsSection } from "./_lib/secrets-section";

const TITLE = "Pod security";
const DESCRIPTION =
  "Who this pod trusts to sign in its users, and where its secrets are kept.";

function SecurityInner() {
  return (
    <PageShell>
      <PageHeader title={TITLE} description={DESCRIPTION} />

      <div className="mb-6 flex flex-col gap-5">
        <PresenceModeCard />
        <SensitivityCard />
        <PasskeysCard returnTo="/security#passkeys" />
      </div>

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
    </PageShell>
  );
}

export default function SecurityPage() {
  // Next 16's `useSearchParams` requires a Suspense boundary.
  return (
    <Suspense fallback={<PageFallback />}>
      <SecurityInner />
    </Suspense>
  );
}

"use client";

/**
 * Pod security — who the pod trusts, and where its secrets live.
 *
 * First the pod's one switch for people: "Approvals need you in person"
 * (the proof-of-presence mode, W3 slice 3), then what asks for it on this
 * pod, then one line about your OWN ways to confirm it's you, with the door
 * to your Security page where they are listed and managed (founder, 7 Nov
 * 2026, session 539e519b: one place, never a second passkeys card here).
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
import { WaysInSummary } from "../../_lib/presence/ways-in/ways-in-summary";
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
        <WaysInSummary />
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

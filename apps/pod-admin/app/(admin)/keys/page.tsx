"use client";

/**
 * Keys — every API key that can reach this pod (operator, agent, CLI,
 * service and system keys). `?focus=<keyId>` (⌘K, Home) is received by the
 * key list. How long a computer's key lasts is set on Computers, where the
 * computers are.
 */

import { Suspense } from "react";
import { PageFallback, PageHeader, PageShell } from "../components/page-header";
import { ApiKeysSection } from "./_lib/api-keys-section";

const TITLE = "Keys";
const DESCRIPTION = "Every API key that can reach this pod.";

export default function KeysPage() {
  return (
    // `useFocusRow` inside the key list reads `useSearchParams`, which Next 16
    // wants under a Suspense boundary.
    <Suspense fallback={<PageFallback />}>
      <PageShell>
        <PageHeader title={TITLE} description={DESCRIPTION} />
        <ApiKeysSection />
      </PageShell>
    </Suspense>
  );
}

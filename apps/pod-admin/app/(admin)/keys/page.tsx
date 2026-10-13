"use client";

/**
 * Keys — every API key that can reach this pod (operator, agent, CLI,
 * service and system keys), and the default lifetime of a connected
 * computer's key. `?focus=<keyId>` (⌘K, Home) is received by the key list.
 */

import { Suspense } from "react";
import { PageFallback, PageHeader, PageShell } from "../components/page-header";
import { ApiKeysSection } from "./_lib/api-keys-section";
import { ComputerKeyLifetime } from "./_lib/computer-key-lifetime";

const TITLE = "Keys";
const DESCRIPTION =
  "Every API key that can reach this pod, and how long a connected computer's key lasts.";

export default function KeysPage() {
  return (
    // `useFocusRow` inside the key list reads `useSearchParams`, which Next 16
    // wants under a Suspense boundary.
    <Suspense fallback={<PageFallback />}>
      <PageShell>
        <PageHeader title={TITLE} description={DESCRIPTION} />
        <div className="flex flex-col gap-5">
          <ApiKeysSection />
          <ComputerKeyLifetime />
        </div>
      </PageShell>
    </Suspense>
  );
}

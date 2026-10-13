/**
 * /sessions — every piece of work on the pod, by where it stands. The page is
 * the client component; this file only gives `useSearchParams` (?filter=,
 * ?focus=) its Suspense boundary.
 */

import { Suspense } from "react";
import { PageFallback } from "../components/page-header";
import { SessionsPage } from "./_lib/sessions-page";

export default function Sessions() {
  return (
    <Suspense fallback={<PageFallback />}>
      <SessionsPage />
    </Suspense>
  );
}

/**
 * /kinds — the kinds of things the pod holds. The page is the client
 * component; this file gives `useSearchParams` (`?focus=`) its Suspense
 * boundary.
 */

import { Suspense } from "react";
import { PageFallback } from "../components/page-header";
import { KindsPage } from "./_lib/kinds-page";

export default function Kinds() {
  return (
    <Suspense fallback={<PageFallback />}>
      <KindsPage />
    </Suspense>
  );
}

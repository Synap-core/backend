/**
 * /kinds — the kinds of things the pod holds. The page is the client
 * component; this file gives `useSearchParams` (`?focus=`) its Suspense
 * boundary.
 */

import { Suspense } from "react";
import { PageHeader } from "../components/page-header";
import { ResourceRowSkeleton } from "../components/resource-row";
import { KindsPage } from "./_lib/kinds-page";
import { KINDS_DESCRIPTION, KINDS_TITLE } from "./_lib/kinds-model";

export default function Kinds() {
  return (
    <Suspense
      fallback={
        <div className="max-w-[1100px] px-4 py-6 sm:px-6">
          <PageHeader title={KINDS_TITLE} description={KINDS_DESCRIPTION} />
          <ResourceRowSkeleton count={6} />
        </div>
      }
    >
      <KindsPage />
    </Suspense>
  );
}

"use client";

/**
 * /keys/new — the New key page (keys plan §3.1): a page reached by a door
 * ("New key" on Keys, "Create key" on a space, Add connection), never a
 * modal. `?template=<id>` opens it on a template, `?space=<id>` makes the key
 * for one space, `?holder=system|service` mints it for the pod or a service.
 * The key is shown once in the Reveal dialog, then the page opens its row.
 */

import { Suspense } from "react";
import { PageFallback } from "../../components/page-header";
import { KeyCreateForm } from "./_lib/key-create-form";

export default function NewKeyPage() {
  return (
    // The form reads `useSearchParams`, which Next 16 wants under Suspense.
    <Suspense fallback={<PageFallback />}>
      <KeyCreateForm />
    </Suspense>
  );
}

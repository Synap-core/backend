/**
 * /sessions/:id — one session in the console. The body is the shared one
 * (`app/_lib/object/views/session-body.tsx`) that `/open/session/:id` draws;
 * this route only adds the console frame. A malformed id fails that read and
 * renders its failure state, rather than a second validation here.
 */

import { SessionDetail } from "../_lib/session-detail";

export const dynamic = "force-dynamic";

export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SessionDetail id={id} />;
}

/** Updates proxy — `GET /api/pod-updates` → `{ settings, lastUpdate, canEdit }`. */

import { forwardToPod } from "./_forward";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return forwardToPod(req, "");
}

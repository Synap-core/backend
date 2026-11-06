/**
 * Computer defaults proxy — `GET /api/machine-defaults`.
 *
 * The pod default lifetime of a computer's key (and its agents' keys), founder
 * decision 4 of MACHINE-IDENTITY-PLAN. `apiKeys.getMachineDefaults` is a
 * `podAdminProcedure` — the pod re-checks the role, this route only forwards
 * the cookie through the RAW caller (see `lib/pod-trpc.ts`).
 *
 * Changing it (`apiKeys.setMachineDefaults`) is not here: it is a sensitive
 * action (W3 slice 3), so the page calls it with its proof of presence
 * through `app/_lib/presence` (tripwire `presence-approve-doors`).
 */

import { apiSessionDenial } from "../../../lib/kratos";
import { callPodQuery } from "../../../lib/pod-trpc";
import type { MachineDefaults } from "../../../lib/machine-defaults";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = await apiSessionDenial(req);
  if (denied) return denied;
  const res = await callPodQuery<MachineDefaults>(
    "apiKeys.getMachineDefaults",
    undefined,
    req.headers
  );
  if (!res.ok)
    return Response.json({ error: res.message }, { status: res.status });
  return Response.json(res.data);
}

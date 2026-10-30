/**
 * /history — Historique: what was decided on the requests, with each
 * decision's receipt and Undo where it can still be undone (decision G2:
 * "what happened" grows from Review › History; `/audit` stays the
 * operator's). A member page (route-policy `MEMBER_CONSOLE_PATHS`): the read
 * is floored on the viewer and Undo re-checks the reviewer's authority.
 */

import { HistoryPage } from "./_lib/history-page";

export const dynamic = "force-dynamic";

export default function History() {
  return <HistoryPage />;
}

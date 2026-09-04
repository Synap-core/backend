/**
 * Run-ledger event vocabulary — the strings the REFUSAL half of the runs feed is
 * keyed on, shared by the emitters and the reader.
 *
 * A ZERO-IMPORT leaf, deliberately NOT part of `lib/ai-events.ts`: that module
 * pulls `@synap/database` (via routing-tunables), and `utils/permission-check.ts`
 * is exercised by suites that replace `@synap/database` with a TOTAL `vi.mock`.
 * A static import of anything in that chain there kills every test in the file
 * with "No <X> export is defined on the mock" — the hazard these constants must
 * not re-introduce.
 */
/**
 * `data.kind` (and the `ai_decision` action) for a plain AGENT WRITE's event.
 *
 * Written ONLY for a REFUSED write today (`data.outcome: "refused"`): an
 * executed agent write leaves an AUTO_APPROVED proposal receipt, which is the
 * row `listAgentWriteRuns` reads. A write the daily-cap floor refused has NO
 * receipt — it neither executed nor proposed — so the event IS its only row.
 * Same string in the emitter (utils/permission-check.ts) and the reader
 * (services/runs/index.ts); a drift here silently empties the ledger.
 */
export const AGENT_WRITE_EVENT_KIND = "agent_write";
/**
 * `data.outcome` marking a run event as a REFUSAL rather than a delivered run.
 * Its ABSENCE means delivered — every event written before this existed is a
 * successful run, so no backfill is needed and none is implied.
 */
export const REFUSED_OUTCOME = "refused";

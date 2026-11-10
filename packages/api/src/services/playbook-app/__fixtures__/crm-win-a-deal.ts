/**
 * A REAL catalog playbook and the kind it works, as fixture: CRM's "Win a
 * deal" over `deal` (synap-app `packages/workspace-templates/src/crm.yaml` at
 * ae228e35f, lines 279-297 and 1195-1290). Copied, not imported: the catalog
 * this package pins (`@synap-core/workspace-templates` 0.11.0) predates
 * declared lifecycles and stage statuses.
 *
 * Every status key, status label, stage key and stage name below is what a
 * generated cell must NOT spell: it reads them from `flow.of`.
 */

export const WIN_A_DEAL_ID = "6f0c1a2e-3b4d-4c5e-8f60-718293a4b5c6";

/** `deal`'s declared lifecycle (property `commercialStage`). */
export const DEAL_LIFECYCLE = {
  property: "commercialStage",
  options: [
    { key: "draft", label: "Meeting booked", category: "open" },
    { key: "proposed", label: "Proposal sent", category: "active" },
    { key: "negotiating", label: "Negotiating", category: "active" },
    { key: "won", label: "Won", category: "done" },
    { key: "lost", label: "Lost", category: "lost" },
  ],
} as const;

/** "Win a deal": its stages, the ones that own a state carry `subjectStatus`. */
export const WIN_A_DEAL_STAGES = [
  { key: "qualify", name: "Qualify", subjectStatus: "draft" },
  { key: "write", name: "Write proposal" },
  { key: "send", name: "Send proposal", subjectStatus: "proposed" },
  { key: "await-answer", name: "Awaiting the answer" },
  { key: "negotiate", name: "Negotiate", subjectStatus: "negotiating" },
  { key: "won", name: "Won", subjectStatus: "won" },
] as const;

export const WIN_A_DEAL_PLAYBOOK = {
  id: WIN_A_DEAL_ID,
  name: "Win a deal",
  subjectProfile: { profileSlug: "deal" },
  stages: WIN_A_DEAL_STAGES,
} as const;

/** Every word the cell must read rather than spell. */
export const WIN_A_DEAL_FLOW_WORDS: string[] = [
  ...DEAL_LIFECYCLE.options.flatMap((o) => [o.key, o.label]),
  ...WIN_A_DEAL_STAGES.flatMap((s) => [s.key, s.name]),
];

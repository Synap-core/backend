/**
 * The `ExpectedOutput.kind` an UNANSWERED REQUIRED PLAYBOOK PARAM is filed
 * under, when a HEADLESS door (MCP / CLI / cron / Raycast) starts a run that
 * declares one and nobody supplied it.
 *
 * Why a slot and not a refusal: the interactive doors have a form, so they
 * refuse and the person fills it in. A headless caller has no form, and the two
 * alternatives are both wrong — refusing kills an unattended run over a
 * question nobody was asked, and substituting `""` (what happened before this
 * existed) hands the agent a mutilated instruction and calls it a success. The
 * slot is the honest third answer: the run exists, the question is visible, it
 * is owed by a person, and it ages.
 *
 * ONE definition, and it lives HERE for the reason {@link CRITERION_SLOT_KIND}
 * spells out: the readers are UIs, and a needs-you tray must tell a param slot
 * from an ordinary deliverable because it takes a DIFFERENT verb — supply the
 * value and re-run, never "I did this" / attest.
 */
export const PARAM_SLOT_KIND = "playbook_param";

/**
 * A playbook's deliverables as a session's SLOTS — the one answer to "which
 * of the playbook's expected outputs does this session not carry yet".
 *
 * Shared by the two doors that bind a playbook to a session: the start door
 * (`create-session.ts`, `templateId`) and the follow door
 * (`follow-playbook.ts`, `followPlaybookId`). Before this, only the follow
 * door turned them into slots; a session STARTED from a playbook only
 * snapshotted them on its `playbook_runs` row, so the deliverables the
 * playbook declares were owed by nobody and could not be completed.
 *
 * Matched by LABEL (`normalizeExpectedLabel`), so binding again — a follow of
 * the playbook the session was started from — never files a slot twice. Keys
 * are minted from the label by the birth door (`stampSlotKeys`), so the same
 * deliverable gets the same key on every session.
 */

import type { ExpectedOutput } from "@synap/playbooks";
import { normalizeExpectedLabel } from "./expected-label.js";
import { sanitizeDeclaredOutputs } from "./update-session.js";

/** The playbook's slots that `current` does not already carry, by label. */
export function playbookSlotsMissingFrom(
  playbook: { expectedOutputs: unknown },
  current: readonly ExpectedOutput[]
): ExpectedOutput[] {
  const have = new Set(
    current.map((o) => normalizeExpectedLabel(o?.label)).filter(Boolean)
  );
  const fromPlaybook = Array.isArray(playbook.expectedOutputs)
    ? (playbook.expectedOutputs as ExpectedOutput[])
    : [];
  const seen = new Set<string>();
  return sanitizeDeclaredOutputs(
    fromPlaybook.filter((o) => {
      const key = normalizeExpectedLabel(o?.label);
      if (!key || have.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
  );
}

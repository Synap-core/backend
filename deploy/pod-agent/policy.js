"use strict";

/**
 * The pod owner's local command policy (SECURITY-PLAN-R1 §2, decision D3).
 *
 * A signed command proves WHAT the Control Plane ordered; it says nothing
 * about whether the pod's owner consents. On a self-hosted (BYO) pod the
 * owner — not the CP — decides whether the CP may archive the pod, restore
 * an archive over it, or rewrite its env. This file is the consent line:
 *
 *   <deploy>/state/pod-agent-policy.json   (owner-editable; never CP-writable:
 *                                           `configure` only writes .env keys)
 *   {
 *     "mode": "self-hosted" | "managed",
 *     "refuse": ["archive", ...],           // optional; replaces the mode default
 *     "archiveRecipients": ["age1…", ...]   // D15: who can decrypt an archive
 *   }
 *
 * Defaults: `managed` refuses nothing; `self-hosted` refuses archive,
 * restore-archive and configure. NO FILE = self-hosted: the pod-agent cannot
 * tell a managed pod from a BYO one by itself (both install from the same
 * cloud-init bytes), so the safe side is the default and a managed pod's
 * operator writes `"mode": "managed"` once. An unreadable or invalid file
 * fails CLOSED to the self-hosted refusals — a typo never widens consent.
 *
 * Read on every command, so an owner's edit applies without a restart.
 */

const fs = require("fs");
const path = require("path");

const POLICY_FILE = "pod-agent-policy.json";
const POLICY_MODES = Object.freeze(["managed", "self-hosted"]);
/** What a self-hosted pod refuses unless its owner says otherwise (D3). */
const SELF_HOSTED_REFUSALS = Object.freeze([
  "archive",
  "restore-archive",
  "configure",
]);
/** age recipients: X25519 (`age1…`) and plugin recipients (`age1<plugin>1…`). */
const AGE_RECIPIENT_PATTERN = /^age1[0-9a-z]{20,200}$/;
const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

function policyFile(deployDir) {
  return path.join(deployDir, "state", POLICY_FILE);
}

function closedPolicy(source, error) {
  return {
    source,
    mode: "self-hosted",
    refuse: new Set(SELF_HOSTED_REFUSALS),
    archiveRecipients: [],
    error,
  };
}

/**
 * The effective policy. Never throws: `error` is set (and the policy is the
 * closed default) when the file exists but cannot be used.
 */
function readPodAgentPolicy(file, readFile = fs.readFileSync) {
  let raw;
  try {
    raw = readFile(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return closedPolicy("default", null);
    return closedPolicy("file", "POD_POLICY_UNREADABLE");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return closedPolicy("file", "POD_POLICY_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return closedPolicy("file", "POD_POLICY_INVALID");
  }
  if (!POLICY_MODES.includes(parsed.mode)) {
    return closedPolicy("file", "POD_POLICY_INVALID");
  }
  let refuse;
  if (parsed.refuse === undefined) {
    refuse = parsed.mode === "managed" ? [] : SELF_HOSTED_REFUSALS;
  } else if (
    Array.isArray(parsed.refuse) &&
    parsed.refuse.every(
      (name) => typeof name === "string" && COMMAND_NAME_PATTERN.test(name)
    )
  ) {
    refuse = parsed.refuse;
  } else {
    return closedPolicy("file", "POD_POLICY_INVALID");
  }
  const recipients = parsed.archiveRecipients ?? [];
  if (
    !Array.isArray(recipients) ||
    !recipients.every(
      (r) => typeof r === "string" && AGE_RECIPIENT_PATTERN.test(r)
    )
  ) {
    return closedPolicy("file", "POD_POLICY_INVALID");
  }
  return {
    source: "file",
    mode: parsed.mode,
    refuse: new Set(refuse),
    archiveRecipients: [...new Set(recipients)],
    error: null,
  };
}

function policyRefusal(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Throws a typed refusal when the owner's policy does not consent to
 * `commandName`, or when an archive has nobody to encrypt it to (D15).
 */
function assertCommandAllowed(policy, commandName) {
  if (policy.refuse.has(commandName)) {
    throw policyRefusal(
      "POD_POLICY_REFUSED",
      `This pod's owner policy refuses "${commandName}" commands` +
        (policy.error ? ` (${policy.error}: policy file unusable)` : "") +
        " — see deploy/state/pod-agent-policy.json."
    );
  }
  if (commandName === "archive" && policy.archiveRecipients.length === 0) {
    throw policyRefusal(
      "ARCHIVE_RECIPIENT_MISSING",
      "Archives leave this host age-encrypted; no archiveRecipients are set in deploy/state/pod-agent-policy.json."
    );
  }
}

module.exports = {
  AGE_RECIPIENT_PATTERN,
  POLICY_FILE,
  SELF_HOSTED_REFUSALS,
  assertCommandAllowed,
  policyFile,
  readPodAgentPolicy,
};

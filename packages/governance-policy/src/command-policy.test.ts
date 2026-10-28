/**
 * Audit F8 (2026-10-28): the shell door's content check and its operator
 * switch. The commands below are the audit's own: each passed the old
 * denylist and read the API process's secrets or the database.
 */
import { describe, expect, it } from "vitest";
import {
  COMMAND_BLOCKED_REFUSAL,
  COMMAND_SUBSTITUTION_REFUSAL,
  commandPolicyRefusal,
  isPodShellAllowed,
} from "./command-policy.js";

describe("commandPolicyRefusal", () => {
  it.each([
    "cat /proc/1/environ | tr '\\0' '\\n' | head -40",
    "tr '\\0' '\\n' < /proc/self/environ",
    "printenv",
    "env",
    "env | grep DATABASE",
    "true && env > /tmp/x",
    "node -e \"require('pg')\"",
    "node --eval 'process.env'",
    "psql $DATABASE_URL -c 'select 1'",
  ])("refuses a read of the pod's secrets: %s", (command) => {
    expect(commandPolicyRefusal(command)).toBe(COMMAND_BLOCKED_REFUSAL);
  });

  it("still refuses the old patterns and substitution", () => {
    expect(commandPolicyRefusal("rm -rf /")).toBe(COMMAND_BLOCKED_REFUSAL);
    expect(commandPolicyRefusal("echo $(id)")).toBe(
      COMMAND_SUBSTITUTION_REFUSAL
    );
    expect(commandPolicyRefusal("echo `id`")).toBe(
      COMMAND_SUBSTITUTION_REFUSAL
    );
  });

  it.each([
    "git status",
    "npm test",
    "npm run env:check",
    "/usr/bin/env python3 script.py",
    "docker ps --env-file .env.example",
    "node scripts/build.js",
  ])("lets an ordinary command through: %s", (command) => {
    expect(commandPolicyRefusal(command)).toBeNull();
  });

  it("refuses a missing command", () => {
    expect(commandPolicyRefusal(undefined)).not.toBeNull();
    expect(commandPolicyRefusal("  ")).not.toBeNull();
  });
});

describe("isPodShellAllowed", () => {
  it("is off by default", () => {
    expect(isPodShellAllowed({}, false)).toBe(false);
    expect(isPodShellAllowed({ SYNAP_LOCAL_TERMINAL: "true" }, false)).toBe(
      false
    );
    expect(isPodShellAllowed({ SYNAP_LOCAL_TERMINAL: "0" }, false)).toBe(false);
  });

  it("is on only for the operator's switch or the local single-user pod", () => {
    expect(isPodShellAllowed({ SYNAP_LOCAL_TERMINAL: "1" }, false)).toBe(true);
    expect(isPodShellAllowed({}, true)).toBe(true);
  });
});

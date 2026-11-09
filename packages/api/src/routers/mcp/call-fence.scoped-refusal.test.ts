/**
 * What a scoped key is told when the MCP call fence refuses it a read tool
 * (finding 92708a1e). `synap_list_installations` SUPPORTS scoped keys: it is
 * the PERSON door `installation`, and a key whose grant reads `installation`
 * (the AI preset since 2026-11-07) calls it. A key minted before that has no
 * such permission, and was told "This door does not support scoped keys yet",
 * which sent the agent (and the person) looking for a missing feature when the
 * fix was one permission on the key.
 *
 * Driven through `toolCallRefusal`, the function the tools/call door runs,
 * with the tool's REAL definition from the committed manifest (its
 * `readOnlyHint` decides which door classifies it).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  AI_READ_PROPOSE_ROLE_ID,
  GRANT_PRESETS,
} from "@synap-core/types/grants";

import { toolCallRefusal } from "./call-fence.js";
import { GRANT_DOOR_UNSUPPORTED } from "../../access/grant-door-fence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(
  readFileSync(resolve(HERE, "tools/mcp-tools.manifest.json"), "utf8")
) as { tools: Tool[] };
const toolDefs = MANIFEST.tools;

const AI_PERMISSIONS = GRANT_PRESETS.find(
  (r) => r.id === AI_READ_PROPOSE_ROLE_ID
)!.grant.permissions;
const agent = (permissions: readonly string[], narrowing = {}) => ({
  isAgent: true,
  keyType: "user_pat",
  grant: {
    scopes: [{ permissions: [...permissions], ...narrowing }],
    clientId: null,
  } as never,
});
/** The AI preset as it was minted before `installation` joined it. */
const BEFORE_INSTALLATIONS = AI_PERMISSIONS.filter(
  (p) => !p.startsWith("installation")
);

describe("synap_list_installations for a scoped key", () => {
  it("the tool is in the manifest, read-only (non-vacuity)", () => {
    const tool = toolDefs.find((t) => t.name === "synap_list_installations");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    // The preset reads installations, and the "before" key differs by that.
    expect(AI_PERMISSIONS).toContain("installation.read");
    expect(BEFORE_INSTALLATIONS).not.toContain("installation.read");
    expect(BEFORE_INSTALLATIONS.length).toBeGreaterThan(20);
  });

  it("runs for a key whose grant reads installations (the AI preset today)", () => {
    expect(
      toolCallRefusal(
        "synap_list_installations",
        toolDefs,
        agent(AI_PERMISSIONS)
      )
    ).toBeNull();
    expect(
      toolCallRefusal(
        "synap_list_installations",
        toolDefs,
        agent(["installation.read"])
      )
    ).toBeNull();
  });

  it("refuses a key without it, naming the one permission to add", () => {
    const refusal = toolCallRefusal(
      "synap_list_installations",
      toolDefs,
      agent(BEFORE_INSTALLATIONS)
    );
    expect(refusal).not.toBeNull();
    expect(refusal).not.toBe(GRANT_DOOR_UNSUPPORTED);
    expect(refusal).toContain("'installation.read'");
    expect(refusal).toContain("synap_list_installations");
  });

  it("a deny-all key is still refused, and told the permission", () => {
    expect(
      toolCallRefusal("synap_list_installations", toolDefs, agent([]))
    ).toContain("'installation.read'");
  });

  it("a door no grant can open keeps the unsupported text", () => {
    // A tool the fence does not classify: no permission would open it.
    const unclassified: Tool = {
      name: "synap_not_a_classified_tool",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    };
    expect(
      toolCallRefusal(
        unclassified.name,
        [...toolDefs, unclassified],
        agent(AI_PERMISSIONS)
      )
    ).toBe(GRANT_DOOR_UNSUPPORTED);
  });
});

import { describe, expect, it } from "vitest";
import {
  CapabilityDefinitionSchema,
  McpServerDefSchema,
  VaultDefSchema,
} from "./capabilities.js";

/**
 * The three 0257 template fields must SURVIVE parsing.
 *
 * Zod's `z.object` STRIPS unknown keys without an error. So a field a template
 * declares but the schema does not list parses "successfully" and silently
 * disappears — the declared-but-dropped defect. For these fields that failure is
 * not cosmetic:
 *   - `auth` dropped      → the server installs, then every call 401s
 *   - `toolPolicy` dropped → a read-only server's tools all become proposals
 *   - `podWide` dropped   → the agent can never redeem the key in chat
 *
 * So each case asserts the VALUE ARRIVES in the parsed output, not merely that
 * parsing succeeded.
 */

const SERVER = {
  slug: "freellmapi",
  name: "FreeLLMAPI",
  transport: "http" as const,
  url: "{{baseUrl}}/mcp",
  auth: {
    credentialRef: "unifiedKey",
    header: "Authorization",
    prefix: "Bearer ",
  },
  toolPolicy: { default: "governed" as const, inline: ["list_models"] },
};

const VAULT = {
  ref: "unifiedKey",
  name: "FreeLLMAPI unified key",
  value: "{{apiKey}}",
  type: "api_key" as const,
  podWide: true,
};

describe("0257 template fields survive parsing", () => {
  it("McpServerDefSchema keeps auth", () => {
    expect(McpServerDefSchema.parse(SERVER).auth).toEqual(SERVER.auth);
  });

  it("McpServerDefSchema keeps toolPolicy", () => {
    expect(McpServerDefSchema.parse(SERVER).toolPolicy).toEqual(
      SERVER.toolPolicy
    );
  });

  it("VaultDefSchema keeps podWide", () => {
    expect(VaultDefSchema.parse(VAULT).podWide).toBe(true);
  });

  it("the whole definition carries them through (the applier's actual input)", () => {
    const parsed = CapabilityDefinitionSchema.parse({
      key: "freellmapi",
      name: "FreeLLMAPI",
      vault: [VAULT],
      mcpServers: [SERVER],
      tools: [],
      skills: [],
    });
    expect(parsed.vault?.[0]?.podWide).toBe(true);
    expect(parsed.mcpServers?.[0]?.auth?.credentialRef).toBe("unifiedKey");
    expect(parsed.mcpServers?.[0]?.toolPolicy?.default).toBe("governed");
  });

  it("rejects an auth header name that is not a valid HTTP token", () => {
    // Guards header injection through a template: a value with a newline or
    // colon would otherwise reach the IS transport's request headers.
    expect(() =>
      McpServerDefSchema.parse({
        ...SERVER,
        auth: { credentialRef: "unifiedKey", header: "X-Evil: 1\r\nInjected" },
      })
    ).toThrow();
  });

  it("rejects an unknown toolPolicy default", () => {
    expect(() =>
      McpServerDefSchema.parse({ ...SERVER, toolPolicy: { default: "open" } })
    ).toThrow();
  });
});

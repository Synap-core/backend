import { describe, expect, it } from "vitest";
import { projectWorkspaceSettings } from "./workspace-client-projection.js";

describe("projectWorkspaceSettings", () => {
  it("keeps client layout while dropping credential and unknown containers", () => {
    const workspace = {
      id: "ws-1",
      settings: {
        layout: {
          primarySurface: {
            kind: "app",
            appId: "crm",
            rendererType: "external",
            url: "https://crm.synap.live",
          },
        },
        nango: { secretKey: "nango-secret" },
        messaging: { unipileApiKey: "messaging-secret" },
        enrichment: { apifyToken: "enrichment-secret" },
        controlPlane: { telegramBotToken: "telegram-secret" },
        mcpServers: [{ env: { API_KEY: "mcp-secret" } }],
        futureCredentialBag: { token: "future-secret" },
      },
    };

    const projected = projectWorkspaceSettings(workspace);

    expect(projected).not.toBe(workspace);
    expect(projected.settings).toEqual({
      layout: workspace.settings.layout,
    });
    expect(JSON.stringify(projected)).not.toContain("secret");
    expect(workspace.settings.nango.secretKey).toBe("nango-secret");
  });

  it("leaf-projects devplane instead of exposing per-user provider secrets", () => {
    expect(
      projectWorkspaceSettings({
        settings: {
          devplane: {
            localTerminalEnabled: true,
            userProviders: {
              "user-1": { openai: { apiKeyVaultRef: "vault-secret-ref" } },
            },
          },
        },
      }).settings
    ).toEqual({
      devplane: { localTerminalEnabled: true },
    });
  });

  it("fails closed when a malformed settings value is not an object", () => {
    expect(projectWorkspaceSettings({ settings: "plaintext-secret" })).toEqual({
      settings: {},
    });
    expect(
      projectWorkspaceSettings({ settings: ["plaintext-secret"] })
    ).toEqual({
      settings: {},
    });
  });
});

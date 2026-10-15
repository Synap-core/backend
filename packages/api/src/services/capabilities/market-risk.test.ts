import { describe, it, expect } from "vitest";
import {
  assessMarketRisks,
  INCOMPLETE_RISK_NOTICE,
  missingAcknowledgements,
  requiredAcknowledgements,
  riskNotices,
} from "./market-risk.js";

describe("assessMarketRisks", () => {
  it("finds a lone cell's code and declared egress", () => {
    const risks = assessMarketRisks({
      key: "bar",
      name: "Bar chart",
      code: "export default 1",
      externalHosts: ["api.acme.test", "https://cdn.acme.test/x"],
    });
    expect(risks).toEqual({
      code: ["Bar chart"],
      networkHosts: ["api.acme.test", "cdn.acme.test"],
      connectors: [],
    });
  });

  it("finds what a template carries in its nested layers", () => {
    const risks = assessMarketRisks({
      workspaceName: "CRM",
      cells: [{ key: "funnel", code: "x" }],
      capabilities: [
        {
          definition: {
            key: "acme-crm",
            vault: [{ ref: "api", name: "Acme API key" }],
            tools: [
              {
                name: "sync",
                endpoint: "https://api.acme.test/v1",
                provider: "acme",
              },
            ],
          },
        },
      ],
      automations: [
        {
          name: "Digest",
          flowDefinition: {
            nodes: [{ type: "http", url: "wss://events.acme.test/stream" }],
          },
        },
      ],
      skills: [{ name: "Scorer", kind: "code" }],
      mcpServers: [{ name: "acme-mcp" }],
    });
    expect(risks.code).toEqual(["Scorer", "funnel"]);
    expect(risks.networkHosts).toEqual(["api.acme.test", "events.acme.test"]);
    expect(risks.connectors).toEqual([
      "MCP server: acme-mcp",
      "acme",
      "secret: Acme API key",
    ]);
  });

  it("a plain view package brings nothing to confirm", () => {
    const risks = assessMarketRisks({
      views: [{ type: "kanban", config: {} }],
    });
    expect(requiredAcknowledgements(risks)).toEqual({
      code: false,
      network: false,
    });
    expect(missingAcknowledgements(risks, undefined)).toEqual([]);
    expect(riskNotices(risks)).toEqual([]);
  });

  it("is bounded on a pathological (deep) definition", () => {
    let deep: Record<string, unknown> = { code: "x" };
    for (let i = 0; i < 1000; i++) deep = { child: deep };
    expect(() => assessMarketRisks(deep)).not.toThrow();
  });

  it("fails CLOSED when the walk runs out of budget: code and network both required", () => {
    // Too deep: the code at the bottom is never reached.
    let deep: Record<string, unknown> = { code: "steal()" };
    for (let i = 0; i < 100; i++) deep = { child: deep };
    // Too wide: more nodes than the walk reads.
    const wide = { items: Array.from({ length: 60_000 }, (_, i) => i) };
    for (const def of [deep, wide]) {
      const risks = assessMarketRisks(def);
      expect(risks.incomplete).toBe(true);
      expect(requiredAcknowledgements(risks)).toEqual({
        code: true,
        network: true,
      });
      expect(missingAcknowledgements(risks, undefined)).toEqual([
        INCOMPLETE_RISK_NOTICE,
        "It may run code — confirm that you accept that.",
        "It may reach the network — confirm that you accept that.",
      ]);
      expect(
        missingAcknowledgements(risks, { code: true, network: true })
      ).toEqual([]);
      expect(riskNotices(risks)[0]).toBe(INCOMPLETE_RISK_NOTICE);
    }
  });

  it("a definition read to the end is not incomplete", () => {
    expect(
      assessMarketRisks({ views: [{ type: "kanban" }] })
    ).not.toHaveProperty("incomplete");
  });
});

describe("acknowledgements", () => {
  const risks = assessMarketRisks({
    key: "c",
    code: "x",
    externalHosts: ["a.test"],
  });

  it("asks for each confirm separately until both are given", () => {
    expect(missingAcknowledgements(risks, undefined)).toHaveLength(2);
    expect(missingAcknowledgements(risks, { code: true })).toEqual([
      "It can reach a.test — confirm that you accept that.",
    ]);
    expect(
      missingAcknowledgements(risks, { code: true, network: true })
    ).toEqual([]);
  });

  it("names the risks in the reviewer's notice", () => {
    expect(riskNotices(risks)).toEqual(["Runs code: c.", "Can reach: a.test."]);
  });
});

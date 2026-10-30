import { describe, expect, it } from "vitest";
import {
  diagramAlt,
  isMermaidFence,
  mermaidConfig,
  mermaidRenderId,
  mermaidThemeVariables,
  MERMAID_COLOR_TOKENS,
} from "./mermaid-model";

describe("isMermaidFence", () => {
  it("selects the diagram row by the fence's first word, any case", () => {
    expect(isMermaidFence("mermaid")).toBe(true);
    expect(isMermaidFence("Mermaid title=x")).toBe(true);
  });

  it("leaves every other fence as code", () => {
    expect(isMermaidFence("ts")).toBe(false);
    expect(isMermaidFence("math")).toBe(false);
    expect(isMermaidFence("")).toBe(false);
    expect(isMermaidFence(null)).toBe(false);
    expect(isMermaidFence(undefined)).toBe(false);
  });
});

describe("mermaidConfig", () => {
  it("runs strict, with labels as SVG text", () => {
    const config = mermaidConfig({});
    expect(config.securityLevel).toBe("strict");
    expect(config.htmlLabels).toBe(false);
    expect(config.flowchart.htmlLabels).toBe(false);
    expect(config.startOnLoad).toBe(false);
    expect(config.theme).toBe("base");
  });
});

describe("mermaidThemeVariables", () => {
  it("takes every slot from the console's colour", () => {
    const vars = mermaidThemeVariables(
      (name) => `rgb(${name.length}, 0, 0)`,
      true
    );
    expect(vars.darkMode).toBe(true);
    expect(vars.primaryBorderColor).toBe(`rgb(${"primary".length}, 0, 0)`);
    for (const slot of Object.keys(MERMAID_COLOR_TOKENS)) {
      expect(vars[slot]).toMatch(/^rgb\(/);
    }
  });

  it("leaves a colour the page does not define to mermaid's default", () => {
    const vars = mermaidThemeVariables(
      (name) => (name === "primary" ? "rgb(1, 2, 3)" : null),
      false
    );
    expect(vars).toEqual({
      darkMode: false,
      primaryBorderColor: "rgb(1, 2, 3)",
      nodeBorder: "rgb(1, 2, 3)",
    });
  });

  it("without a reader, only the mode", () => {
    expect(mermaidThemeVariables(null, true)).toEqual({ darkMode: true });
  });
});

describe("diagramAlt / mermaidRenderId", () => {
  it("names the diagram by its first line", () => {
    expect(diagramAlt("\nflowchart LR\n  A --> B")).toBe(
      "Diagram: flowchart LR"
    );
    expect(diagramAlt("   ")).toBe("Diagram");
  });

  it("makes a DOM id from React's id", () => {
    expect(mermaidRenderId(":r1a:")).toBe("pa-mermaid-r1a");
    expect(mermaidRenderId("«r3»")).toBe("pa-mermaid-r3");
  });
});

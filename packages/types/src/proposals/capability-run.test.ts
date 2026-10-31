import { describe, expect, it } from "vitest";
import {
  declaredToolParameters,
  describeToolRun,
  toolRunActionLabel,
} from "./capability-run.js";

const isSecretName = (key: string) => /key|token|secret|password/i.test(key);

/** Proposal 4b5e040e (2026-10-30), the payload the review drew as key names. */
const hcloudParameters = {
  name: "sillage",
  image: "ubuntu-24.04",
  location: "nbg1",
  userData: "#cloud-config\npackage_update: true\n",
  serverType: "cx23",
};

describe("toolRunActionLabel", () => {
  it("reads a vendor-prefixed verb as its action", () => {
    expect(toolRunActionLabel("hcloud_create_server")).toBe("Create server");
  });

  it("reads a dotted verb as its action", () => {
    expect(toolRunActionLabel("hcloud.create_server")).toBe("Create server");
  });

  it("reads a name with no known tail whole, in words, never the raw id", () => {
    const label = toolRunActionLabel("zz_frobnicate_widget");
    expect(label).not.toMatch(/_/);
    expect(label.toLowerCase()).toContain("frobnicate");
  });
});

describe("declaredToolParameters", () => {
  it("reads JSON Schema properties in order, with title, description and secret marks", () => {
    expect(
      declaredToolParameters({
        type: "object",
        properties: {
          serverType: { type: "string", description: "Hetzner server type" },
          name: { type: "string", title: "Server name" },
          apiPass: { type: "string", format: "password" },
        },
      })
    ).toEqual([
      {
        key: "serverType",
        title: undefined,
        description: "Hetzner server type",
        secret: false,
      },
      {
        key: "name",
        title: "Server name",
        description: undefined,
        secret: false,
      },
      {
        key: "apiPass",
        title: undefined,
        description: undefined,
        secret: true,
      },
    ]);
  });

  it("reads the shorthand type map, including a field named `type`", () => {
    expect(
      declaredToolParameters({ query: "string", type: "string?" }).map(
        (d) => d.key
      )
    ).toEqual(["query", "type"]);
  });

  it("reads nothing from a missing or malformed schema", () => {
    expect(declaredToolParameters(null)).toEqual([]);
    expect(declaredToolParameters(["a"])).toEqual([]);
  });
});

describe("describeToolRun", () => {
  it("names the action and the tool, and carries every value the agent passed", () => {
    const run = describeToolRun({
      verbId: "hcloud_create_server",
      skillName: "hcloud_create_server",
      toolNames: ["Hetzner cloud"],
      parameters: hcloudParameters,
      isSecretName,
    });
    expect(run?.action).toBe("Create server");
    expect(run?.tool).toBe("Hetzner cloud");
    expect(
      Object.fromEntries(run!.parameters.map((p) => [p.key, p.value]))
    ).toEqual(hcloudParameters);
    expect(run!.parameters.find((p) => p.key === "serverType")?.label).toBe(
      "Server type"
    );
  });

  it("orders by the declared schema, then the undeclared rest", () => {
    const run = describeToolRun({
      verbId: "hcloud_create_server",
      schema: {
        type: "object",
        properties: {
          serverType: { type: "string", description: "cx23, cpx31…" },
          location: { type: "string" },
          notPassed: { type: "string" },
        },
      },
      parameters: hcloudParameters,
      isSecretName,
    });
    expect(run!.parameters.map((p) => p.key)).toEqual([
      "serverType",
      "location",
      "name",
      "image",
      "userData",
    ]);
    expect(run!.parameters[0]!.description).toBe("cx23, cpx31…");
  });

  it("never carries a secret's value, by name or by schema", () => {
    const run = describeToolRun({
      verbId: "x_create",
      schema: {
        type: "object",
        properties: { pin: { type: "string", writeOnly: true } },
      },
      parameters: { apiToken: "tok_live_123", pin: "1234", city: "Paris" },
      isSecretName,
    });
    const byKey = new Map(run!.parameters.map((p) => [p.key, p]));
    expect(byKey.get("apiToken")).toEqual(
      expect.objectContaining({ secret: true })
    );
    expect(byKey.get("apiToken")).not.toHaveProperty("value");
    expect(byKey.get("pin")).not.toHaveProperty("value");
    expect(byKey.get("city")?.value).toBe("Paris");
    expect(JSON.stringify(run)).not.toContain("tok_live_123");
  });

  it("leaves the agent's reasoning to the review's own line", () => {
    const run = describeToolRun({
      verbId: "x_create",
      parameters: { reasoning: "because", city: "Paris" },
      isSecretName,
    });
    expect(run!.parameters.map((p) => p.key)).toEqual(["city"]);
  });

  it("is null with no verb to name", () => {
    expect(
      describeToolRun({ verbId: null, parameters: {}, isSecretName })
    ).toBeNull();
  });
});

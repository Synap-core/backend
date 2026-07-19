import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { workspacesRouter } from "./workspaces.js";

type ProcedureInputDefinition = {
  _def: { inputs: readonly z.ZodType<unknown>[] };
};

function inputSchema(
  procedureName: "createFromDefinition" | "reconcileFromDefinition"
): z.ZodType<unknown> {
  const procedure = workspacesRouter._def.procedures[
    procedureName
  ] as unknown as ProcedureInputDefinition;
  const [schema] = procedure._def.inputs;

  if (!schema) {
    throw new Error(`${procedureName} must define an input schema.`);
  }

  return schema;
}

const roleProfile = {
  slug: "outreach-status",
  displayName: "Outreach status",
  entityScope: "workspace" as const,
  profileKind: "role" as const,
  applicableKinds: ["person", "company"],
};

describe("workspace definition profile metadata", () => {
  it.each([
    ["createFromDefinition", { definition: { profiles: [roleProfile] } }],
    [
      "reconcileFromDefinition",
      {
        workspaceId: "00000000-0000-4000-8000-000000000001",
        definition: { profiles: [roleProfile] },
      },
    ],
  ] as const)("preserves role metadata for %s", (procedureName, input) => {
    const parsed = inputSchema(procedureName).parse(input) as {
      definition: {
        profiles?: Array<{
          profileKind?: string;
          applicableKinds?: string[];
          entityScope?: string;
        }>;
      };
    };

    expect(parsed.definition.profiles?.[0]).toMatchObject({
      profileKind: "role",
      applicableKinds: ["person", "company"],
      entityScope: "workspace",
    });
  });
});

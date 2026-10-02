/**
 * posthog-analytics — the definition satisfies the REAL install door.
 *
 * `definition.test.ts` proves the package is coherent with the pod RUNTIME
 * (handlers, param schemas, tokens). This file proves the other half is
 * reachable: the definition parses against the ACTUAL door schema the pod
 * applies it through (`CapabilityDefinitionSchema`, exported by
 * `POST /api/hub/capabilities/apply`), and — the part a shape assertion would
 * miss — the SECURITY-RELEVANT declared keys SURVIVE that parse.
 *
 * Why the survival assertion matters: Zod objects STRIP undeclared keys, so a
 * field the door schema does not model is not rejected, it is silently deleted
 * between the package and the applier. A definition that declares
 * `metadata.readOnly: true` on every skill would then install write-shaped verbs
 * — every agent analytics read filed as a human review proposal — while this
 * repo's own tests stayed green. That is a reachability claim, not a shape one.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CapabilityDefinitionSchema } from "../../routers/hub-protocol/rest/capabilities.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFINITION_PATH = join(
  HERE,
  "../../../../../templates/capabilities/posthog-analytics.capability.json"
);

const raw = JSON.parse(readFileSync(DEFINITION_PATH, "utf8")) as Record<
  string,
  unknown
>;

describe("the package installs through the pod's own apply door", () => {
  it("parses against CapabilityDefinitionSchema", () => {
    const parsed = CapabilityDefinitionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `the definition is rejected by the install door: ${parsed.error.message}`
      );
    }
    expect(parsed.success).toBe(true);
  });

  it("keeps every verb's declared read-only posture THROUGH the parse", () => {
    const parsed = CapabilityDefinitionSchema.parse(raw);
    expect(parsed.skills.length).toBe(4);
    for (const skill of parsed.skills) {
      expect(
        (skill.metadata as { readOnly?: unknown } | undefined)?.readOnly,
        `${skill.name}: \`metadata.readOnly\` did not survive CapabilityDefinitionSchema — the door schema is stripping the bag, so the installed skill loses its declared read posture`
      ).toBe(true);
    }
  });

  it("keeps the vault, the pinned tool and the params the tokens need", () => {
    const parsed = CapabilityDefinitionSchema.parse(raw);
    expect(parsed.vault).toHaveLength(1);
    expect(parsed.vault?.[0]?.podWide).toBe(true);
    expect(parsed.tools).toHaveLength(1);
    const tool = parsed.tools![0]!;
    expect(tool.name).toBe("posthog_api");
    expect(tool.kind).toBe("api");
    // credentialRef points at the TEMPLATE-LOCAL ref the applier remaps to the
    // real vault://<id>; a name mismatch would leave the tool pointing nowhere.
    expect(tool.credentialRef).toBe(parsed.vault?.[0]?.ref);
    const config = tool.config as { baseUrl?: string } | undefined;
    expect(config?.baseUrl).toContain("{{projectId}}");
    expect(parsed.params?.map((p) => p.name).sort()).toEqual([
      "analyticsHost",
      "personalApiKey",
      "projectId",
    ]);
  });
});

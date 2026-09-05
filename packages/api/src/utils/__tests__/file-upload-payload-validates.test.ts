import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ProfileResolutionService,
  PropertyValidationService,
  PropertyValueType,
  type EffectiveProperty,
} from "@synap/database";

/**
 * The live 500 (errorId 59b87ca6): `synap upload /tmp/scan.png` →
 * `POST /api/hub/files` → "Property validation failed for profile c1722408-…:
 * property_0: Property 'storageKey' is required".
 *
 * The governed multipart door (`createGovernedFileEntityFromBuffer`) writes
 * exactly `{ mimeType, fileSize }` plus an entity-level `title` — canonical
 * `file` entities deliberately keep their storage pointers on the `documents`
 * row + `entities.documentId` and never duplicate them into properties (see
 * `routers/file-upload.ts`, `isCanonicalFile`). The door was never wrong; the
 * SCHEMA had drifted, carrying a fossil required `storageKey` link that the
 * deleted `scripts/seed-profiles.ts` wrote and no later seed ever unlinked.
 *
 * These two cases pin both sides of the fix:
 *   1. the door's payload validates clean against the seeded `file` schema, and
 *   2. it is precisely the fossil link that rejected it — the link now retired
 *      by `RETIRED_PROFILE_PROPERTIES` in `ensure-system-profiles.ts`.
 *
 * Effective properties are stubbed at the service boundary, so this runs with
 * no database.
 */

/** Minimal EffectiveProperty — only the fields the validator reads. */
function prop(
  slug: string,
  overrides: Partial<EffectiveProperty> = {}
): EffectiveProperty {
  return {
    slug,
    valueType: PropertyValueType.STRING,
    required: false,
    defaultValue: null,
    constraints: {},
    displayOrder: 0,
    ...overrides,
  } as unknown as EffectiveProperty;
}

/** Exactly what the governed multipart door sends for a canonical `file`. */
const DOOR_PAYLOAD = { mimeType: "image/png", fileSize: 12_345 };

/** The `file` profile as the current seed declares it — every prop optional. */
const SEEDED_FILE_SCHEMA: EffectiveProperty[] = [
  prop("title"),
  prop("mimeType"),
  prop("fileSize", {
    valueType: PropertyValueType.NUMBER,
  } as Partial<EffectiveProperty>),
  prop("tags", {
    valueType: PropertyValueType.ARRAY,
  } as Partial<EffectiveProperty>),
];

describe("file upload payload validates against the `file` profile", () => {
  let svc: PropertyValidationService;

  beforeEach(() => {
    vi.restoreAllMocks();
    svc = new PropertyValidationService(
      new ProfileResolutionService({} as never)
    );
  });

  it("the multipart door's payload is accepted by the seeded schema", async () => {
    vi.spyOn(
      ProfileResolutionService.prototype,
      "getEffectiveProperties"
    ).mockResolvedValue(SEEDED_FILE_SCHEMA);

    const res = await svc.validateProperties(
      { ...DOOR_PAYLOAD, title: "scan.png" },
      "profile-file",
      "ws-1"
    );

    expect(res.errors).toEqual([]);
    expect(res.valid).toBe(true);
    // Every key the door writes is modelled — none is silently stored off-schema.
    expect(res.unmodeled).toEqual([]);
  });

  it("the SAME payload is rejected by the fossil schema — the exact 500 that was reported", async () => {
    vi.spyOn(
      ProfileResolutionService.prototype,
      "getEffectiveProperties"
    ).mockResolvedValue([
      ...SEEDED_FILE_SCHEMA,
      // The link left behind by the deleted `scripts/seed-profiles.ts`, still
      // present on every pod seeded while that file existed.
      prop("storageKey", { required: true }),
    ]);

    const res = await svc.validateProperties(
      { ...DOOR_PAYLOAD, title: "scan.png" },
      "profile-file",
      "ws-1"
    );

    expect(res.valid).toBe(false);
    expect(res.errors).toContain("Property 'storageKey' is required");
  });
});

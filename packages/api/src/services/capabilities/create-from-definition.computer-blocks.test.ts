/**
 * The applier hands a capability's computer blocks to the container door.
 *
 * Dogfood, 2026-11-08: `synap market install media-ffmpeg` with a computer's
 * key (an agent) proposed the container. The applier stamps
 * `metadata.computer` (`declaredContainerMetadata`) only on a container that
 * exists at apply time, so the proposal, and the container its approval made,
 * carried none, and the pod answered every installation request for it 404
 * NOT_INSTALLABLE. The declared metadata now rides the create itself.
 *
 * Driven with the catalog's real `media-ffmpeg` 0.35.0 definition (fixture),
 * its skills left out: they are not what the container carries. The
 * container door is a stub answering "proposed" (an agent's ask); the rest of
 * that path (proposal → approval → installable → request) is
 * services/installations/installable-from-catalog.pglite.test.ts.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const m = vi.hoisted(() => ({
  containerCreate: vi.fn(async (_input: Record<string, unknown>) => ({
    capability: null,
    status: "proposed",
    proposalId: "cap-proposal",
  })),
}));

vi.mock("../../routers/playbooks.js", () => ({
  playbooksRouter: { createCaller: () => ({ create: vi.fn() }) },
}));
vi.mock("../../routers/automations.js", () => ({
  automationsRouter: { createCaller: () => ({ create: vi.fn() }) },
}));
vi.mock("./cp-template-client.js", () => ({
  fetchCPCapabilityTemplate: vi.fn(async () => null),
}));
vi.mock("../links/links-service.js", () => ({
  createLinks: vi.fn(async () => []),
}));
vi.mock("../../routers/capability-containers.js", () => ({
  capabilityContainersRouter: {
    createCaller: () => ({
      create: m.containerCreate,
      addPart: vi.fn(async () => ({ ok: true })),
    }),
  },
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => [] as unknown[],
  };
  const upd = { set: () => upd, where: async () => undefined };
  return { ...actual, db: { select: () => chain, update: () => upd } };
});

import { runWithActingAgent } from "@synap/database";
import {
  CapabilityComputerSpecSchema,
  installKind,
  pickComputerSpec,
} from "@synap-core/types/capability-manifest";
import { createCapabilityFromDefinition } from "./create-from-definition.js";

const here = dirname(fileURLToPath(import.meta.url));
const DEF = JSON.parse(
  readFileSync(
    resolve(
      here,
      "../installations/__fixtures__/media-ffmpeg.0.35.0.definition.json"
    ),
    "utf8"
  )
) as Record<string, unknown>;

const WS = "11111111-1111-1111-1111-111111111111";
const UID = "22222222-2222-2222-2222-222222222222";
const MAC = "33333333-3333-3333-3333-333333333333";

describe("createCapabilityFromDefinition — a capability that runs on a computer", () => {
  it("an agent's install hands the container door the computer blocks, installable as they are", async () => {
    await runWithActingAgent(MAC, () =>
      createCapabilityFromDefinition({ ...DEF, skills: [] } as never, {}, {
        userId: UID,
        workspaceId: WS,
      } as never)
    );
    expect(m.containerCreate).toHaveBeenCalledTimes(1);
    const input = m.containerCreate.mock.calls[0]![0];
    expect(input.templateKey).toBe("media-ffmpeg");
    const metadata = input.metadata as Record<string, unknown>;
    expect(metadata.templateKey).toBe("media-ffmpeg");
    expect(metadata.contentHash).toBe(DEF.contentHash);
    expect(metadata.computer).toEqual(pickComputerSpec(DEF));
    // What `loadInstallableCapability` will do with it once approved.
    const parsed = CapabilityComputerSpecSchema.safeParse(metadata.computer);
    expect(parsed.success).toBe(true);
    expect(installKind(parsed.data!)).toBe("tool");
  });
});

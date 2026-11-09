/**
 * The capability manifest's computer blocks (reconciliation f75fbb48 §3.5):
 * a catalog tool manifest (the shape of media-transcribe) parses; the kind is
 * derived (services → service, install.<os> → tool, both refused); the
 * placement check refuses a pod capability, the wrong OS or processor, and
 * passes a computer whose OS is not known yet; the applier's pick keeps every
 * computer key, recipes included.
 */
import { describe, expect, it } from "vitest";
import {
  CapabilityComputerSpecSchema,
  CAPABILITY_COMPUTER_KEYS,
  installKind,
  pickComputerSpec,
  placementRefusal,
} from "./index.js";

const TOOL = {
  placement: {
    runsOn: ["computer"],
    prefer: ["computer"],
    platforms: [
      { os: "darwin", arch: ["arm64"] },
      { os: "linux", arch: ["x64", "arm64"] },
    ],
    labels: ["gpu?"],
    requires: { runtimes: { uv: ">=0.5", python: ">=3.10" } },
  },
  install: {
    darwin: {
      steps: [{ kind: "uv", action: "tool-install", package: "mlx-whisper" }],
      bins: { mlx_whisper: "{home}/.local/bin/mlx_whisper" },
    },
    linux: {
      steps: [
        { kind: "uv", action: "tool-install", package: "whisper-ctranslate2" },
      ],
      bins: { "whisper-ctranslate2": "{home}/.local/bin/whisper-ctranslate2" },
    },
  },
  verify: {
    darwin: {
      command: ["mlx_whisper", "--help"],
      expect: { exitCode: 0, stdoutMatches: "usage: mlx_whisper" },
    },
    linux: {
      command: ["whisper-ctranslate2", "--version"],
      expect: { exitCode: 0, stdoutMatches: "(\\d+\\.\\d+\\.\\d+)" },
      captureVersion: 1,
    },
    reverifyEvery: "P7D",
  },
  uninstall: {
    darwin: {
      steps: [{ kind: "uv", action: "tool-uninstall", package: "mlx-whisper" }],
    },
    linux: {
      steps: [
        {
          kind: "uv",
          action: "tool-uninstall",
          package: "whisper-ctranslate2",
        },
      ],
    },
  },
  permissions: {
    filesystem: [{ path: "{workdir}", access: "rw" }],
    network: ["huggingface.co"],
    devices: ["gpu"],
  },
  licence: "MIT",
};

describe("capability-manifest — the one rule", () => {
  it("a catalog tool manifest parses and is a tool", () => {
    const parsed = CapabilityComputerSpecSchema.safeParse(TOOL);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(installKind(parsed.data!)).toBe("tool");
  });

  it("refuses an unknown key, a bad placeholder, and both kinds at once", () => {
    expect(
      CapabilityComputerSpecSchema.safeParse({ ...TOOL, shell: "rm -rf /" })
        .success
    ).toBe(false);
    const typo = structuredClone(TOOL);
    typo.install.darwin.bins.mlx_whisper = "{homedir}/.local/bin/mlx_whisper";
    expect(CapabilityComputerSpecSchema.safeParse(typo).success).toBe(false);
    const both = {
      ...TOOL,
      services: [
        {
          id: "render",
          image: `ghcr.io/x/render@sha256:${"a".repeat(64)}`,
        },
      ],
    };
    expect(CapabilityComputerSpecSchema.safeParse(both).success).toBe(false);
  });

  it("recipes run on a computer", () => {
    const podOnly = {
      placement: { runsOn: ["pod"] },
      recipes: [],
    };
    const out = CapabilityComputerSpecSchema.safeParse(podOnly);
    expect(out.success).toBe(false);
    expect(JSON.stringify(out.error?.issues)).toContain("recipes");
  });
});

describe("placementRefusal — can it go on this computer", () => {
  it("passes a listed OS and processor, and an OS not known yet", () => {
    expect(placementRefusal(TOOL, { os: "darwin", arch: "arm64" })).toBeNull();
    expect(placementRefusal(TOOL, { os: "linux", arch: "x64" })).toBeNull();
    expect(placementRefusal(TOOL, { os: null, arch: null })).toBeNull();
  });

  it("refuses another OS, another processor, a pod capability, an invalid spec", () => {
    expect(placementRefusal(TOOL, { os: "win32", arch: "x64" })).toMatch(
      /win32/
    );
    expect(placementRefusal(TOOL, { os: "darwin", arch: "x64" })).toMatch(
      /x64/
    );
    expect(
      placementRefusal(
        { ...TOOL, placement: { ...TOOL.placement, runsOn: ["pod"] } },
        { os: "darwin", arch: "arm64" }
      )
    ).toMatch(/pod/);
    expect(
      placementRefusal(
        { placement: { runsOn: ["computer"] }, licence: "MIT" },
        { os: "darwin", arch: "arm64" }
      )
    ).toMatch(/not valid/);
    expect(
      placementRefusal(
        { ...TOOL, install: { darwin: { steps: [] } } },
        {
          os: "darwin",
          arch: "arm64",
        }
      )
    ).toMatch(/not valid/);
  });
});

describe("pickComputerSpec — what the applier stores", () => {
  it("keeps every computer key verbatim, recipes included, and nothing else", () => {
    const def: Record<string, unknown> = { key: "media-x", name: "X" };
    for (const k of CAPABILITY_COMPUTER_KEYS) def[k] = { marker: k };
    const picked = pickComputerSpec(def)!;
    expect(Object.keys(picked).sort()).toEqual(
      [...CAPABILITY_COMPUTER_KEYS].sort()
    );
    expect(picked.recipes).toEqual({ marker: "recipes" });
    expect(picked).not.toHaveProperty("key");
    expect(pickComputerSpec({ key: "web.read", name: "Web" })).toBeNull();
  });
});

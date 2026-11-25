/**
 * Hosted verbs, the rules (plan b647769e §3.2): which computer runs a recipe,
 * and whether a recipe's values hold, BEFORE anything is queued. Each case is
 * a refusal that, without its rule, would queue a run that fails on the
 * computer (or runs where the person did not choose).
 */

import { describe, it, expect } from "vitest";

import {
  chooseRecipeComputer,
  fileIdsOf,
  inputFileName,
  manifestRecipes,
  outputNameProblem,
  recipeValuesProblem,
  type RecipeRunCandidate,
} from "./hosted-verb-rules.js";
import type { ComputerRef } from "../installations/installations.js";

const LOUDNORM = {
  name: "loudness-normalize",
  description: "Two-pass loudness normalisation.",
  params: {
    in: { type: "file", description: "The video.", required: true },
    out: { type: "output", description: "The result.", required: true },
    target: { type: "number", description: "LUFS.", default: -14 },
  },
  steps: [
    {
      program: "python",
      args: [
        "{script:loudnorm2pass.py}",
        "{bin:ffmpeg}",
        "{in}",
        "{out}",
        "{target}",
      ],
    },
  ],
  scripts: [
    {
      name: "loudnorm2pass.py",
      sha256: "0".repeat(64),
      source: "print('x')\n",
    },
  ],
  gotchas: ["Normalise last."],
};
const CROP = {
  name: "reframe-crop",
  description: "Crop to a frame.",
  params: {
    in: { type: "file", description: "The video.", required: true },
    out: { type: "output", description: "The result.", required: true },
    xFrac: { type: "number", description: "Where.", default: 0.5 },
  },
  steps: [
    {
      program: "ffmpeg",
      args: ["-i", "{in}", "-vf", "crop=ih:ih:(iw-ih)*{xFrac}:0", "{out}"],
    },
  ],
  gotchas: ["Shoot 4K."],
};
const MANIFEST = { recipes: [LOUDNORM, CROP, { name: "Broken Recipe" }] };

const FILE = "6f1c1d1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f";

const computer = (id: string, name: string, os = "darwin"): ComputerRef => ({
  id,
  ownerUserId: "p",
  name,
  os,
  arch: "arm64",
  installsFromPod: true,
});
const MAC = computer("m-mac", "MacBook-Pro");
const DEVBOX = computer("m-devbox", "devbox", "linux");
const STUDIO = computer("m-studio", "Mac-Studio");

const cand = (
  machineUserId: string,
  over: Partial<RecipeRunCandidate> = {}
): RecipeRunCandidate => ({
  installationId: `inst-${machineUserId}`,
  machineUserId,
  status: "installed",
  health: "ok",
  healthDetail: null,
  verifiedAt: new Date("2026-11-09T10:00:00Z"),
  manifest: MANIFEST,
  ...over,
});

describe("chooseRecipeComputer — who runs it", () => {
  const computers = [MAC, DEVBOX, STUDIO];

  it("refuses when no computer has the tool, and says how to get it", () => {
    const r = chooseRecipeComputer({
      capabilityKey: "media-ffmpeg",
      candidates: [cand(MAC.id, { status: "removed" })],
      computers,
    });
    expect(r).toMatchObject({ ok: false, code: "NOT_INSTALLED" });
    expect(!r.ok && r.error).toContain("synap_request_installation");
  });

  it("never runs on a computer whose check failed, or that was never checked", () => {
    for (const over of [
      { health: "failed" as const, healthDetail: "ffmpeg: not found" },
      { health: "unknown" as const },
      { status: "installing", health: null },
    ]) {
      const r = chooseRecipeComputer({
        capabilityKey: "media-ffmpeg",
        candidates: [cand(MAC.id, over)],
        computers,
      });
      expect(r, JSON.stringify(over)).toMatchObject({
        ok: false,
        code: "NOT_RUNNABLE",
      });
    }
  });

  it("a stale or drifted tool still runs", () => {
    for (const health of ["stale", "drifted"] as const) {
      const r = chooseRecipeComputer({
        capabilityKey: "media-ffmpeg",
        candidates: [cand(MAC.id, { health })],
        computers,
      });
      expect(r).toMatchObject({ ok: true, computer: { id: MAC.id } });
    }
  });

  it("unnamed: the one checked most recently among the runnable ones", () => {
    const r = chooseRecipeComputer({
      capabilityKey: "media-ffmpeg",
      candidates: [
        cand(MAC.id, { verifiedAt: new Date("2026-11-01T00:00:00Z") }),
        cand(DEVBOX.id, { verifiedAt: new Date("2026-11-09T00:00:00Z") }),
        cand(STUDIO.id, {
          health: "failed",
          verifiedAt: new Date("2026-11-10T00:00:00Z"),
        }),
      ],
      computers,
    });
    expect(r).toMatchObject({ ok: true, computer: { id: DEVBOX.id } });
  });

  it("named: matched among the computers that HAVE the tool, with the request's rungs", () => {
    const candidates = [cand(MAC.id), cand(DEVBOX.id)];
    expect(
      chooseRecipeComputer({
        capabilityKey: "media-ffmpeg",
        candidates,
        computers,
        ref: "mac",
      })
    ).toMatchObject({ ok: true, computer: { id: MAC.id } });
    // Mac-Studio has no ffmpeg: "studio" is not a computer that can run it.
    const r = chooseRecipeComputer({
      capabilityKey: "media-ffmpeg",
      candidates,
      computers,
      ref: "studio",
    });
    expect(r).toMatchObject({ ok: false, code: "COMPUTER_NOT_FOUND" });
    expect(!r.ok && r.error).toContain("MacBook-Pro");
  });

  it("named, but its tool cannot run: refused with why, never another computer", () => {
    const r = chooseRecipeComputer({
      capabilityKey: "media-ffmpeg",
      candidates: [
        cand(MAC.id, { health: "failed", healthDetail: "exit 1" }),
        cand(DEVBOX.id),
      ],
      computers,
      ref: "MacBook-Pro",
    });
    expect(r).toMatchObject({ ok: false, code: "NOT_RUNNABLE" });
    expect(!r.ok && r.error).toContain("repair it first");
  });

  it("never guesses between two computers a name matches", () => {
    const r = chooseRecipeComputer({
      capabilityKey: "media-ffmpeg",
      candidates: [cand(MAC.id), cand(STUDIO.id)],
      computers,
      ref: "mac",
    });
    expect(r).toMatchObject({ ok: false, code: "COMPUTER_AMBIGUOUS" });
  });
});

describe("recipes and their values", () => {
  const [loud, crop] = manifestRecipes(MANIFEST);

  it("reads only the recipes the one schema accepts", () => {
    expect(manifestRecipes(MANIFEST).map((r) => r.name)).toEqual([
      "loudness-normalize",
      "reframe-crop",
    ]);
    expect(manifestRecipes({})).toEqual([]);
    // A catalog manifest nests the blocks under `spec`: the same recipes.
    expect(manifestRecipes({ spec: MANIFEST }).map((r) => r.name)).toEqual([
      "loudness-normalize",
      "reframe-crop",
    ]);
  });

  it("accepts complete, typed values", () => {
    expect(
      recipeValuesProblem(loud!, {
        in: FILE,
        out: "voice-loud.m4a",
        target: -16,
      })
    ).toBeNull();
  });

  it("refuses a missing required param, an unknown one, or a wrong type", () => {
    expect(recipeValuesProblem(loud!, { out: "a.m4a" })).toContain(
      "in is required"
    );
    expect(
      recipeValuesProblem(loud!, { in: FILE, out: "a.m4a", gain: 3 })
    ).toContain("unknown param gain");
    expect(
      recipeValuesProblem(loud!, { in: FILE, out: "a.m4a", target: "loud" })
    ).toContain("target");
  });

  it("a file param is a pod file id, never a path on the computer", () => {
    for (const bad of ["/etc/passwd", "../x.mp4", 42])
      expect(recipeValuesProblem(loud!, { in: bad, out: "a.m4a" })).toContain(
        "pod file id"
      );
    expect(recipeValuesProblem(loud!, { in: [FILE], out: "a.m4a" })).toContain(
      "not a list"
    );
  });

  it("an output is a bare file name with an extension, never a path", () => {
    for (const bad of [
      "../../.ssh/authorized_keys",
      "/tmp/x.mp4",
      "out",
      "a b.mp4",
      "..mp4",
    ]) {
      expect(outputNameProblem(bad), bad).not.toBeNull();
      expect(recipeValuesProblem(loud!, { in: FILE, out: bad }), bad).toContain(
        "out must be"
      );
    }
    expect(outputNameProblem("clip-loud.mp4")).toBeNull();
  });

  it("a value spliced into a filter graph cannot break out of it (renderRecipe's own rule)", () => {
    expect(
      recipeValuesProblem(crop!, { in: FILE, out: "c.mp4", xFrac: 0.3 })
    ).toBeNull();
    expect(
      recipeValuesProblem(crop!, {
        in: FILE,
        out: "c.mp4",
        xFrac: "0,drawtext",
      })
    ).not.toBeNull();
  });

  it("names the pod files a run needs, per param", () => {
    expect(fileIdsOf(loud!, { in: FILE, out: "a.m4a" })).toEqual({
      in: [FILE],
    });
  });

  it("an input is written under a cleaned name, never a path from its title", () => {
    expect(inputFileName("../../My clip (final).MP4", "in", 0)).toBe(
      "0-My-clip-final-.MP4"
    );
    expect(inputFileName(null, "in", 1)).toBe("1-in");
    expect(inputFileName("no-extension", "in", 2)).toBe("2-in");
  });
});

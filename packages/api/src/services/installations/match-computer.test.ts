/**
 * Which computer a caller means: "install it on my Mac" (founder's dogfood,
 * 2026-11-09). On build df644e0b, `computer: "Mac"` answered
 * COMPUTER_NOT_FOUND although the person had exactly ONE macOS computer,
 * named `MacBook-Pro-de-Antoine.local` (the CLI calls it without `.local`).
 * Each rung of `matchComputer` gets a row it alone decides, and every
 * ambiguous row pins that it never guesses between two.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pickComputerSpec } from "@synap-core/types/capability-manifest";
import type { ComputerRef } from "./installations.js";
import { computerChoices, matchComputer } from "./request-installation.js";

const computer = (
  id: string,
  name: string,
  os: string | null,
  arch: string | null = null
): ComputerRef => ({
  id,
  ownerUserId: "person",
  name,
  os,
  arch,
  installsFromPod: true,
});

const here = dirname(fileURLToPath(import.meta.url));

// The founder's roster as the pod lists it.
const MAC = computer("c-mac", "MacBook-Pro-de-Antoine.local", "darwin");
const DEVBOX = computer("c-devbox", "devbox", "linux");
const HERMES = computer("c-hermes", "hermes", "linux");
const ROSTER = [DEVBOX, HERMES, MAC];

const found = (ref: string, list: ComputerRef[] = ROSTER) => {
  const m = matchComputer(list, ref);
  return m.status === "found" ? m.computer.id : m.status;
};

describe("matchComputer: each rung", () => {
  it("1. its id", () => {
    expect(found("c-hermes")).toBe("c-hermes");
  });

  it("2. its exact name wins over a case-insensitive twin", () => {
    const upper = computer("c-up", "Devbox", "linux");
    expect(found("Devbox", [DEVBOX, upper])).toBe("c-up");
    expect(found("devbox", [DEVBOX, upper])).toBe("c-devbox");
  });

  it("3. any case, a trailing .local ignored (the CLI's name for the Mac)", () => {
    expect(found("MacBook-Pro-de-Antoine")).toBe("c-mac");
    expect(found("macbook-pro-de-antoine.LOCAL")).toBe("c-mac");
  });

  it("4. a unique prefix, or each word starting a word of the name", () => {
    expect(found("macbook")).toBe("c-mac");
    expect(found("dev")).toBe("c-devbox");
    expect(found("antoine")).toBe("c-mac");
    expect(found("MacBook Pro")).toBe("c-mac");
  });

  it('5. a system: "mac" / "macos" → the only macOS computer', () => {
    // "macos" is no prefix of "macbook-…": only the system rung finds it.
    expect(found("macos")).toBe("c-mac");
    const mini = computer("c-mini", "studio", "darwin");
    expect(found("macos", [DEVBOX, mini])).toBe("c-mini");
    const win = computer("c-win", "Surface", "win32");
    expect(found("windows", [DEVBOX, win])).toBe("c-win");
  });

  it('the founder\'s "Mac" finds the Mac', () => {
    expect(found("Mac")).toBe("c-mac");
    expect(found("mac")).toBe("c-mac");
  });
});

describe("matchComputer: two fit, it never guesses", () => {
  it('"linux" with two Linux computers answers both', () => {
    const m = matchComputer(ROSTER, "linux");
    expect(m.status).toBe("ambiguous");
    expect(
      m.status === "ambiguous" && m.candidates.map((c) => c.id).sort()
    ).toEqual(["c-devbox", "c-hermes"]);
  });

  it("a prefix two names share answers both", () => {
    const m = matchComputer(
      [
        computer("a", "MacBook-Pro", "darwin"),
        computer("b", "MacBook-Air", "darwin"),
      ],
      "macbook"
    );
    expect(m.status).toBe("ambiguous");
  });

  it('"mac" with two Macs (no name says mac) answers both', () => {
    const m = matchComputer(
      [computer("a", "studio", "darwin"), computer("b", "laptop", "darwin")],
      "mac"
    );
    expect(m.status).toBe("ambiguous");
  });

  it("two computers with the same name (any case) answer both", () => {
    const m = matchComputer(
      [computer("a", "devbox", "linux"), computer("b", "devbox", "linux")],
      "devbox"
    );
    expect(m.status).toBe("ambiguous");
  });
});

describe("matchComputer: nothing fits", () => {
  it.each(["Laptop", "", "   ", "windows"])("%j is not found", (ref) => {
    expect(found(ref)).toBe("not_found");
  });
});

describe("computerChoices: a processor not reported yet is unknown, never refused", () => {
  // Synap's media-ffmpeg definition, narrowed to Apple silicon on a Mac (as
  // mlx-whisper is), so the processor decides.
  const spec = pickComputerSpec(
    JSON.parse(
      readFileSync(
        resolve(here, "__fixtures__/media-ffmpeg.0.35.0.definition.json"),
        "utf8"
      )
    ) as Record<string, unknown>
  )!;
  const armOnlyOnMac = {
    ...spec,
    placement: {
      ...(spec.placement as Record<string, unknown>),
      platforms: [
        { os: "darwin", arch: ["arm64"] },
        { os: "linux", arch: ["x64", "arm64"] },
        { os: "win32", arch: ["x64"] },
      ],
    },
  };
  const choice = (arch: string | null) =>
    computerChoices([{ ...MAC, arch }], armOnlyOnMac)[0]!;

  it("unknown: allowed, and the why says the processor is not known yet", () => {
    expect(choice(null)).toMatchObject({ canInstall: true, arch: null });
    expect(choice(null).why).toMatch(/processor is not known yet/);
  });
  it("reported and supported: allowed, nothing to explain", () => {
    expect(choice("arm64")).toMatchObject({ canInstall: true });
    expect(choice("arm64").why).toBeUndefined();
  });
  it("reported and not supported: refused on its processor", () => {
    expect(choice("x64")).toMatchObject({ canInstall: false });
    expect(choice("x64").why).toMatch(/processor \(x64\)/);
  });
});

/**
 * An `installation/request` card names the capability and the computer.
 * Before, the title fell to the generic door ("Request Installation"), and
 * only the agent's reasoning said what would be installed where. The title
 * is derived at read from what the ask stored (`requestInstallation`'s
 * payload: computerName, capabilityKey, action, `catalog` when approving
 * adds the capability from the marketplace), through the vocabulary door
 * `buildInstallationTitle`, and it outranks a stored generic summary.
 *
 * Driven with the payload `requestInstallation` files (the field names are
 * pinned by request-installation.pglite.test.ts, which asserts the same
 * payload reaches the gate).
 */
import { describe, it, expect } from "vitest";
import { buildInstallationTitle } from "@synap-core/types/vocabulary";
import { proposalDisplaySummary } from "../display.js";
import { buildProposalSummary } from "../../../utils/permission-check.js";

const ffmpeg = {
  computerId: "11111111-1111-4111-8111-111111111111",
  computerName: "Mac",
  capabilityKey: "media-ffmpeg",
  kind: "tool",
  action: "install",
  catalog: {
    slug: "media-ffmpeg",
    name: "ffmpeg on your computer",
    version: "0.35.0",
    licence: "GPL-2.0-or-later",
  },
};

const summaryOf = (data: Record<string, unknown>, summary?: string) =>
  proposalDisplaySummary({
    proposalType: "request",
    request: {
      targetType: "installation",
      changeType: "request",
      ...(summary ? { summary } : {}),
      data,
    } as never,
  });

describe("installation/request: the card names the capability and the computer", () => {
  it("an addition from the marketplace says so", () => {
    expect(summaryOf(ffmpeg)).toBe(
      'Add "ffmpeg on your computer" from the marketplace and install it on Mac'
    );
  });

  it("a capability already on the pod: install, update, remove", () => {
    const { catalog: _c, ...onPod } = ffmpeg;
    expect(summaryOf(onPod)).toBe('Install "media-ffmpeg" on Mac');
    expect(summaryOf({ ...onPod, action: "update" })).toBe(
      'Update "media-ffmpeg" on Mac'
    );
    expect(summaryOf({ ...onPod, action: "remove" })).toBe(
      'Remove "media-ffmpeg" from Mac'
    );
  });

  it('is the summary the ask is STORED with (what activity, session titles and notifications read), never "Request Installation"', () => {
    expect(buildProposalSummary("installation", "request", ffmpeg)).toBe(
      summaryOf(ffmpeg)
    );
    const { catalog: _c, ...onPod } = ffmpeg;
    expect(buildProposalSummary("installation", "request", onPod)).toBe(
      'Install "media-ffmpeg" on Mac'
    );
  });

  it("outranks a stored generic summary", () => {
    expect(summaryOf(ffmpeg, "Request Installation")).toContain("on Mac");
  });

  it("another proposal is untouched", () => {
    expect(
      proposalDisplaySummary({
        proposalType: "create",
        request: {
          targetType: "entity",
          changeType: "create",
          data: { computerName: "Mac", capabilityKey: "x", action: "install" },
        } as never,
      })
    ).not.toContain("on Mac");
  });

  it("speaks French through the catalog", () => {
    expect(
      buildInstallationTitle({
        action: "install",
        name: "ffmpeg",
        computer: "Mac",
        locale: "fr",
      })
    ).toBe("Installer « ffmpeg » sur Mac");
  });
});

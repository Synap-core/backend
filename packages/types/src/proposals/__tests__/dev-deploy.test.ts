/**
 * A deploy approval says what it lets ship: the step, the commit and where it
 * lands, never "Approve deploy Session …" (founder, 2026-10-30: a push to main
 * read as approving the session).
 */
import { describe, expect, it } from "vitest";
import {
  DEV_DEPLOY_STEPS,
  describeDevDeployProposal,
  devDeployStepOf,
} from "../dev-deploy.js";

const row = (data: Record<string, unknown>) => ({
  proposalType: "dev.deploy_approval",
  data: {
    sessionId: "63bc4338-0000-4000-8000-000000000000",
    repo: "Synap-core/control-plane-api",
    branch: "main",
    commitSha: "a524c103d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6",
    gateReport: { passed: true },
    targetHost: "control-plane-api main",
    deployCommand: "git push origin a524c103:main",
    ...data,
  },
});

describe("describeDevDeployProposal", () => {
  it("a push names the commit, the branch and the repo", () => {
    const d = describeDevDeployProposal(row({ step: "push" }))!;
    expect(d.title).toBe(
      "Push a524c103 to main in Synap-core/control-plane-api"
    );
    expect(d.recordTitle).toBe(
      "Push of a524c103 to main in Synap-core/control-plane-api"
    );
    expect(d.title).not.toMatch(/Session|Deploy/);
  });

  it("a publish names the repo it publishes from", () => {
    const d = describeDevDeployProposal(
      row({
        step: "publish",
        repo: "Synap-core/synap-cli",
        deployCommand: "pnpm publish",
      })
    )!;
    expect(d.title).toBe("Publish a524c103 from Synap-core/synap-cli");
  });

  it("a deploy names its target's first clause", () => {
    const d = describeDevDeployProposal(
      row({
        step: "deploy",
        repo: "Synap-core/app-bases (synap-app, apps/devplane)",
        targetHost:
          "devplane.synap.live (Vercel project devplane, production; today a 162-day-old build)",
        deployCommand: "vercel deploy --prod",
      })
    )!;
    expect(d.title).toBe(
      "Deploy a524c103 from Synap-core/app-bases to devplane.synap.live"
    );
  });

  it("a target given as a URL names its host, never the scheme", () => {
    const d = describeDevDeployProposal(
      row({
        step: "deploy",
        repo: "Synap-core/site-crm",
        targetHost: "https://crm.synap.live",
        deployCommand: "vercel deploy --prod",
      })
    )!;
    expect(d.title).toBe(
      "Deploy a524c103 from Synap-core/site-crm to crm.synap.live"
    );
    const ship = describeDevDeployProposal(
      row({
        deployCommand: "./release.sh",
        targetHost: "http://pod.example.org:8080/x",
      })
    )!;
    expect(ship.title).toBe(
      "Ship a524c103 from Synap-core/control-plane-api main to pod.example.org"
    );
  });

  it("the steps the pod accepts are the steps the heading words", () => {
    for (const step of DEV_DEPLOY_STEPS) {
      const d = describeDevDeployProposal(
        row({ step, deployCommand: "./release.sh" })
      )!;
      expect(d.step).toBe(step);
      expect(
        d.title.startsWith(step.charAt(0).toUpperCase() + step.slice(1))
      ).toBe(true);
    }
  });

  it("an approval with no step is read from its command, and a push to main is a push", () => {
    const d = describeDevDeployProposal(row({}))!;
    expect(d.step).toBe("push");
    expect(d.title).toBe(
      "Push a524c103 to main in Synap-core/control-plane-api"
    );
  });

  it("a command that names no step says Ship, never Deploy", () => {
    const d = describeDevDeployProposal(
      row({ deployCommand: "./release.sh", targetHost: "pod-prod (eve)" })
    )!;
    expect(d.step).toBeNull();
    expect(d.title).toBe(
      "Ship a524c103 from Synap-core/control-plane-api main to pod-prod"
    );
  });

  it("a local repo path reads as its folder", () => {
    const d = describeDevDeployProposal(
      row({ step: "push", repo: "/Users/x/Code/synap-backend/" })
    )!;
    expect(d.title).toBe("Push a524c103 to main in synap-backend");
  });

  it("another kind, or a payload that cannot say what ships, gets null", () => {
    expect(
      describeDevDeployProposal({
        proposalType: "dev.plan_approval",
        data: row({}).data,
      })
    ).toBeNull();
    expect(describeDevDeployProposal(row({ commitSha: "" }))).toBeNull();
    expect(
      describeDevDeployProposal({
        proposalType: "dev.deploy_approval",
        data: null,
      })
    ).toBeNull();
  });
});

describe("devDeployStepOf", () => {
  it.each([
    ["git push origin HEAD:main", "push"],
    ["git -C /abs/repo push origin main", "push"],
    ["npm publish --access public", "publish"],
    ["fly deploy", "deploy"],
    ["vercel --prod --yes", "deploy"],
    ["./release.sh", null],
  ])("%s → %s", (command, step) => {
    expect(devDeployStepOf(command)).toBe(step);
  });
});

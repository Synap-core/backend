/**
 * TRIPWIRE: every approve door pod admin calls goes through the ONE
 * proof-of-presence helper (W3, plan "Proof of presence, pod-first").
 *
 * A sensitive approval (connect an AI, change who may do what, deploy,
 * delete) is refused `PRESENCE_REQUIRED` once a pod runs `enforce`; the
 * helper in `app/_lib/presence/` asks the person for a passkey and approves
 * again. A page that calls an approve door around it typechecks, works in
 * `report` mode, and breaks the day the pod flips to `enforce`. So:
 *
 *  - every non-test source file is scanned (derived, never hand-listed), and
 *    an approve door may be called only inside `app/_lib/presence/`;
 *  - inside it, each file that calls a door goes through
 *    `approveWithPresence` / `approveEachWithPresence`;
 *  - the doors are checked against the pod: every router file that takes a
 *    proof (`presenceProofSchema`) is one this guard knows, with as many
 *    proof inputs as it knows. A new door that takes a proof fails here until
 *    it is added to DOORS (and so routed through the helper);
 *  - the dialog is mounted once, in `app/providers.tsx`.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../../../scripts/strip-comments.mjs";

const APP_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const API_ROUTERS = join(APP_ROOT, "../../packages/api/src/routers");
const HOME = "app/_lib/presence/";

/** Each pod approve door that takes a proof, as pod admin would call it. */
const DOORS: Record<string, RegExp> = {
  "tRPC proposals.approve":
    /\bproposals\s*\.\s*approve\s*\.\s*(?:useMutation|mutate|mutateAsync)\b/,
  "tRPC proposals.batchApprove":
    /\bproposals\s*\.\s*batchApprove\s*\.\s*(?:useMutation|mutate|mutateAsync)\b/,
  "tRPC secretsVault.grantAIAccess":
    /\bsecretsVault\s*\.\s*grantAIAccess\s*\.\s*(?:useMutation|mutate|mutateAsync)\b/,
  // `…/approve`, `/approve-batch`, or a templated verb (`…/${action}`), which
  // is how the agent-connect page once sent approve and reject alike.
  "REST /setup/agent/pending/:keyId/approve and /approve-batch":
    /\/setup\/agent\/pending\/[^`"'\s]*?(?:approve(?:-batch)?\b|\/\$\{)/,
  "REST /proposals/:id/approve": /\/api\/hub\/proposals\/[^`"'\s]*\/approve\b/,
};

/**
 * The pod's router files that take a proof, and how many proof inputs each
 * has (imports not counted). Contract: pod document "W3 pod-first: proof of
 * presence on the pod", section "As built".
 */
const POD_DOORS: Record<string, { inputs: number; doors: string[] }> = {
  "proposals.ts": {
    inputs: 2,
    doors: ["tRPC proposals.approve", "tRPC proposals.batchApprove"],
  },
  "secrets-vault.ts": {
    inputs: 1,
    doors: ["tRPC secretsVault.grantAIAccess"],
  },
  "hub-protocol/rest/setup.ts": {
    inputs: 2,
    doors: ["REST /setup/agent/pending/:keyId/approve and /approve-batch"],
  },
  "hub-protocol/rest/proposals.ts": {
    inputs: 1,
    doors: ["REST /proposals/:id/approve"],
  },
};

function walk(dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "__tests__")
      continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, keep));
    else if (keep(name)) out.push(p);
  }
  return out;
}

const isSource = (name: string) =>
  /\.(ts|tsx)$/.test(name) &&
  !name.endsWith(".d.ts") &&
  !/\.(test|spec)\.tsx?$/.test(name);

const rel = (p: string) => relative(APP_ROOT, p).split(sep).join("/");

const SOURCES = [
  ...walk(join(APP_ROOT, "app"), isSource),
  ...walk(join(APP_ROOT, "lib"), isSource),
].map((p) => ({
  path: rel(p),
  src: stripComments(readFileSync(p, "utf8"), "ts"),
}));

function doorsIn(src: string): string[] {
  return Object.entries(DOORS)
    .filter(([, re]) => re.test(src))
    .map(([name]) => name);
}

describe("TRIPWIRE: pod admin approves only through the proof-of-presence helper", () => {
  it("scans the whole app, and finds the doors in the helper (the scan works)", () => {
    expect(SOURCES.length).toBeGreaterThan(200);
    const home = SOURCES.filter((f) => f.path.startsWith(HOME));
    const found = new Set(home.flatMap((f) => doorsIn(f.src)));
    expect([...found].sort()).toEqual(
      [
        "REST /setup/agent/pending/:keyId/approve and /approve-batch",
        "tRPC proposals.approve",
        "tRPC proposals.batchApprove",
      ].sort()
    );
  });

  it("no page calls an approve door around the helper", () => {
    const bypass = SOURCES.filter((f) => !f.path.startsWith(HOME)).flatMap(
      (f) => doorsIn(f.src).map((door) => `${f.path}: ${door}`)
    );
    expect(
      bypass,
      "These call an approve door directly. Approve through app/_lib/presence (useApproveProposal, useBatchApproveProposals, approvePendingKey, approvePendingKeys), so the pod's PRESENCE_REQUIRED gets its passkey proof."
    ).toEqual([]);
  });

  it("inside the helper, every door goes through approveWithPresence / approveEachWithPresence", () => {
    const raw = SOURCES.filter(
      (f) =>
        f.path.startsWith(HOME) &&
        doorsIn(f.src).length > 0 &&
        !/\bapprove(?:Each)?WithPresence\s*(?:<[^>]*>)?\s*\(/.test(f.src)
    ).map((f) => f.path);
    expect(raw).toEqual([]);
  });

  it("the doors match the pod: every router input that takes a proof is known", () => {
    expect(existsSync(API_ROUTERS), API_ROUTERS).toBe(true);
    const found: Record<string, number> = {};
    for (const p of walk(API_ROUTERS, isSource)) {
      const src = stripComments(readFileSync(p, "utf8"), "ts").replace(
        /import\s*(?:type\s*)?\{[^}]*\}\s*from\s*["'][^"']+["'];?/g,
        ""
      );
      const n = (src.match(/\bpresenceProofSchema\b/g) ?? []).length;
      if (n > 0) found[relative(API_ROUTERS, p).split(sep).join("/")] = n;
    }
    expect(
      found,
      "A pod door's proof inputs changed. Add the door to DOORS / POD_DOORS and route pod admin through app/_lib/presence."
    ).toEqual(
      Object.fromEntries(
        Object.entries(POD_DOORS).map(([file, d]) => [file, d.inputs])
      )
    );
    for (const d of Object.values(POD_DOORS)) {
      for (const door of d.doors) expect(DOORS[door], door).toBeDefined();
    }
  });

  it("the dialog is mounted once, around every page and toast", () => {
    const mounts = SOURCES.filter((f) => /<PresenceProvider\b/.test(f.src));
    expect(mounts.map((f) => f.path)).toEqual(["app/providers.tsx"]);
    const providers = mounts[0]!.src;
    expect(providers.indexOf("<PresenceProvider")).toBeLessThan(
      providers.indexOf("<ToastProvider")
    );
    expect(providers.indexOf("</PresenceProvider>")).toBeGreaterThan(
      providers.indexOf("{children}")
    );
  });
});

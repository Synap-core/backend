/**
 * TRIPWIRE `device-refresh-token-retire-writers` — every code path that marks
 * a refresh token revoked (`oauth_refresh_tokens.revoked_at`) is one of the
 * KNOWN writers below, each with the reason it is safe.
 *
 * WHY (PR #59, console-security review): a Synap app's device refresh is
 * single-use, and redeem (routers/oauth/refresh.ts) reads "this device token
 * is revoked while its device lives" as a REUSE — two holders — and ends the
 * device. That reading is true only because exactly ONE writer revokes a
 * single token of a live device: the retry grace (`deviceRetryGrace`), which
 * retires an unused successor. A new writer that revokes a device token and
 * leaves the device alive would make every later presentation of that token
 * sign the person out as a "theft". So a new writer must be classified here,
 * with its reason, before it ships.
 *
 * HOW (derived): every non-test source file of packages/api, packages/database
 * and apps/api is parsed with the TypeScript compiler; a WRITER is a function
 * holding `.update(oauthRefreshTokens).set({ revokedAt … })`, or SQL text
 * `UPDATE oauth_refresh_tokens … revoked_at`. The found set must EQUAL the
 * classified set: a new writer fails, and so does a classified writer that
 * no longer exists (the list stays true).
 *
 * NON-VACUITY: the scan parses > 300 files and finds every classified writer;
 * a synthetic source with a writer in an unknown function is flagged by the
 * SAME analyzer.
 *
 * WHAT IT DOES NOT SEE (stated): a write through a table held in a variable,
 * or SQL assembled from fragments. Granularity is the function name.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const ROOTS = ["packages/api/src", "packages/database/src", "apps/api/src"];
const SKIP = new Set(["node_modules", "dist", "__fixtures__"]);

/** Every writer of `revoked_at` on refresh tokens, and why it is safe. */
const CLASSIFIED: Record<string, string> = {
  deviceRetryGrace:
    "THE single-token retire: a device's UNUSED successor, during a retry (R7). The one writer that leaves the device alive.",
  revokeRefreshFamily:
    "a whole family, then the connection's access key: for a device, the device ends (revokeConnectionAccessKey).",
  revokePersonDevice: "the device ends in the same transaction as its tokens.",
  revokeConnectionRefreshTokens:
    "an app's tokens (`app_id = …`): never a device's.",
  startRefreshFamily:
    "a NEW connection's earlier tokens; for a device that is the device signInPersonDevice just created, which has none.",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".d.ts")
    )
      out.push(full);
  }
  return out;
}

function enclosingName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (
      (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) &&
      n.name &&
      (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))
    ) {
      return n.name.text;
    }
    if (
      (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
      ts.isVariableDeclaration(n.parent) &&
      ts.isIdentifier(n.parent.name)
    ) {
      return n.parent.name.text;
    }
  }
  return "<module>";
}

const SQL_WRITE = /update\s+"?oauth_refresh_tokens"?[\s\S]*revoked_at/i;

/** The functions of one source that write `revoked_at` on refresh tokens. */
function revokedAtWriters(source: string, fileName: string): string[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "update" &&
      node.arguments[0] &&
      ts.isIdentifier(node.arguments[0]) &&
      node.arguments[0].text === "oauthRefreshTokens"
    ) {
      const set = node.parent;
      const call = set?.parent;
      if (
        set &&
        ts.isPropertyAccessExpression(set) &&
        set.name.text === "set" &&
        call &&
        ts.isCallExpression(call) &&
        call.arguments[0] &&
        ts.isObjectLiteralExpression(call.arguments[0]) &&
        call.arguments[0].properties.some(
          (p) =>
            p.name !== undefined &&
            ts.isIdentifier(p.name) &&
            p.name.text === "revokedAt"
        )
      ) {
        found.push(enclosingName(node));
      }
    }
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node)) &&
      SQL_WRITE.test(node.getText(sf))
    ) {
      found.push(enclosingName(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const files = ROOTS.flatMap((root) => walk(join(REPO, root)));
const writers = new Set<string>();
for (const file of files) {
  const source = readFileSync(file, "utf8");
  if (!/oauthRefreshTokens|oauth_refresh_tokens/.test(source)) continue;
  for (const name of revokedAtWriters(source, file)) writers.add(name);
}

describe("tripwire: device-refresh-token-retire-writers", () => {
  it("every writer of a refresh token's revoked_at is classified, and every classified writer exists", () => {
    const unclassified = [...writers].filter((w) => !(w in CLASSIFIED));
    expect(
      unclassified,
      `New writer(s) of oauth_refresh_tokens.revoked_at: ${unclassified.join(", ")}. ` +
        "Redeem reads a revoked device token on a live device as a REUSE and ends the device; " +
        "classify the writer in CLASSIFIED with why that stays true (refresh.ts R1/R7)."
    ).toEqual([]);
    const gone = Object.keys(CLASSIFIED).filter((w) => !writers.has(w));
    expect(
      gone,
      `Classified writer(s) no longer found: ${gone.join(", ")}`
    ).toEqual([]);
  });

  it("NON-VACUITY — the scan is wide, and the analyzer flags an unknown writer", () => {
    expect(files.length).toBeGreaterThan(300);
    expect(writers.size).toBeGreaterThanOrEqual(Object.keys(CLASSIFIED).length);
    const sample = `
      export async function sneaky(id: string) {
        await db.update(oauthRefreshTokens).set({ revokedAt: new Date() }).where(eq(oauthRefreshTokens.id, id));
      }
      const viaSql = async () => sql\`UPDATE oauth_refresh_tokens SET revoked_at = now()\`;
      export async function harmless() {
        await db.update(oauthRefreshTokens).set({ lastUsedAt: new Date() });
      }`;
    expect(revokedAtWriters(sample, "sample.ts")).toEqual(["sneaky", "viaSql"]);
  });
});

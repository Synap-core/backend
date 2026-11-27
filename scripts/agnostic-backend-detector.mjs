/**
 * agnostic-backend-detector.mjs — counts DOMAIN vocabulary in the generic backend.
 *
 * The rule (founder, 27 Nov 2026; pod skill `rules/agnostic-backend`): the
 * generic backend carries no domain or dev-flow workflow logic. A domain (dev,
 * CRM, content...) is catalog content in a space: kinds + lifecycles,
 * playbooks, automations, capabilities, views. The tripwire
 * `agnostic-backend.tripwire.test.ts` ratchets these counts per file.
 *
 * WHAT IT READS: the TypeScript AST of each file, so comments are never
 * counted (prose ABOUT the rule is not the rule broken). Two families:
 *
 *  - DEV: a dev-flow word sequence inside one identifier, string or template
 *    text. Identifiers and strings are split into lowercase words at camelCase,
 *    `_`, `.`, `-`, `:` and spaces, so `pullRequestUrl`, `pull_request`,
 *    `"dev.pr_merged"` and `"a pull request"` all read as words. Each token is
 *    a short word sequence (`pull request`, `pr merged`, `devbox`...).
 *  - DOMAIN: a string literal whose WHOLE text is a catalog domain's kind or
 *    role (`"lead"`, `"deal"`...) anywhere; a content kind (`"post"`,
 *    `"article"`) only in a kind position and a domain status (`"Published"`,
 *    `"engaged"`) only in a status position: the value of, or compared with, a
 *    name containing kind / slug / profile (resp. status / stage), because
 *    `"post"` is also an HTTP method and `"Published"` a generic verb label.
 *
 * DOES NOT SEE (stated, measured on 2026-11-27): domain logic spelled in
 * generic words (a status compared through a variable, a kind slug read from
 * config then hard-branched), a lone `pr` word (rejected: `pr` also names
 * "pending review" in knowledge/queue-question.ts), `github` (rejected: an
 * integration identity signal, 79 hits mostly in adapters and identity
 * resolution), `"won"`/`"lost"` (generic lifecycle categories), `"contact"`
 * and `"client"` (system kinds and OAuth clients), lowercase `"published"`
 * (the generic site-sharing feature). Granularity is the file and the token
 * count: a file that swaps one hit for another at a flat count stays green.
 *
 * Self-contained apart from `typescript` (node: imports otherwise).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * The generic layers, relative to the backend root. A file joins the scan by
 * existing under one of them; nothing is hand-listed.
 */
export const ROOTS = [
  "packages/api/src/services",
  "packages/api/src/routers",
  "packages/jobs/src",
  "packages/types/src",
  "packages/database/src/services",
  "packages/database/src/utils",
];

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "__tests__",
  "__tripwires__",
  "__fixtures__",
  "__mocks__",
  "fixtures",
  "testing",
]);
const SKIP_FILE_RE = /\.(test|spec|stories)\.tsx?$|\.d\.ts$|\.generated\.ts$/;

/**
 * DEV-flow tokens: word sequences (each word a regex over one lowercase word).
 * Keep this list SHORT: each one must name the dev flow and nothing generic.
 * Hit counts per token are measured in the PR that sets them (report mode:
 * AGNOSTIC_BACKEND_REPORT=1).
 */
export const DEV_TOKENS = [
  {
    id: "pull request",
    words: ["pull", "requests?"],
    why: "the GitHub unit of change",
  },
  {
    id: "pr merged|opened|closed",
    words: ["prs?", "(merged|opened|closed|merge|open|close)"],
    why: "PR lifecycle events (dev.pr_merged...)",
  },
  {
    id: "pr state|checks|url|number|ref",
    words: ["prs?", "(state|states|checks?|url|number|ref|refs|mergeable)"],
    why: "PR facts read by generic code",
  },
  {
    id: "ci started|finished",
    words: ["ci", "(started|finished|verdict|run|runs|failure)"],
    why: "CI run events (ci.finished)",
  },
  {
    id: "required checks",
    words: ["required", "checks"],
    why: "a repo's branch-protection checks",
  },
  {
    id: "repo snapshot|health",
    words: ["repo", "(snapshot|main|health|live)"],
    why: "dev.repo_snapshot and repo main health",
  },
  {
    id: "merge queue",
    words: ["merge", "(queue|queued)"],
    why: "GitHub merge queue",
  },
  { id: "main red", words: ["main", "red"], why: "a repo's red main branch" },
  {
    id: "negctl",
    words: ["negctl"],
    why: "negative-control branches of the devbox gate",
  },
  { id: "devbox", words: ["devbox"], why: "the shared gate machine" },
  {
    id: "devplane",
    words: ["devplane"],
    why: "the devplane_* kinds and router",
  },
  { id: "dev loop", words: ["dev", "loop"], why: "the dev-loop event family" },
  {
    id: "dev hold|signal|fact|event",
    words: [
      "dev",
      "(hold|holds|signal|signals|fact|facts|event|events|ref|refs)",
    ],
    why: "dev holds and dev signals",
  },
  {
    id: "work release",
    words: ["work", "releases?"],
    why: "the PR-release fold (work-release)",
  },
];

/** A string literal whose WHOLE text is one of these, anywhere: a domain kind or role. */
export const DOMAIN_LITERALS = [
  { text: "lead", why: "CRM role (catalog: crm)" },
  { text: "deal", why: "CRM kind (catalog: crm)" },
  { text: "prospect", why: "CRM role or status (catalog: crm)" },
  { text: "opportunity", why: "CRM kind (catalog: crm)" },
  { text: "invoice", why: "finance kind (catalog)" },
];

/**
 * Literals counted only in a POSITION: the value of, or compared with, a name
 * matching `name`. `"post"` is also an HTTP method and `"Published"` also a
 * generic verb label, so anywhere would be noise.
 */
export const DOMAIN_POSITIONAL = [
  {
    texts: ["post", "article", "episode"],
    name: /kind|slug|profile/i,
    why: "content kinds (catalog: content)",
  },
  {
    texts: ["Published", "engaged", "qualified", "booked"],
    name: /status|stage/i,
    why: "domain lifecycle statuses (declared on the kind)",
  },
];

/**
 * Legitimate generic homes: a file here is not counted. EXPLICIT, one reason
 * each; a path that no longer exists is RED (the tripwire checks), so the list
 * cannot rot. Keep it short: every entry is a place the rule does not apply.
 */
export const ALLOWLIST = {
  "packages/types/src/vocabulary/object-kinds.ts":
    "the ONE noun door (rules/vocabulary): it must name the kinds it labels, catalog or not",
};

/** Split an identifier or text into lowercase words. */
export function wordsOf(text) {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const DEV_RES = DEV_TOKENS.map((t) => ({
  id: t.id,
  res: t.words.map((w) => new RegExp(`^(?:${w})$`)),
}));

/** Dev-token hits in one text, by token id. */
function devHits(text, into) {
  const w = wordsOf(text);
  for (const t of DEV_RES) {
    const n = t.res.length;
    for (let i = 0; i + n <= w.length; i++) {
      let ok = true;
      for (let j = 0; j < n && ok; j++) ok = t.res[j].test(w[i + j]);
      if (ok) into[t.id] = (into[t.id] ?? 0) + 1;
    }
  }
}

const DOMAIN_SET = new Set(DOMAIN_LITERALS.map((d) => d.text));

function nameText(n, sf) {
  if (!n) return "";
  if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) return n.text;
  if (ts.isStringLiteral(n)) return n.text;
  return n.getText(sf);
}

/** Is this literal the value of, or compared with, a name matching `nameRe`? */
function inPosition(lit, sf, nameRe) {
  const p = lit.parent;
  if (!p) return false;
  if (ts.isPropertyAssignment(p) && p.initializer === lit)
    return nameRe.test(nameText(p.name, sf));
  if (ts.isVariableDeclaration(p) && p.initializer === lit)
    return nameRe.test(nameText(p.name, sf));
  if (ts.isBinaryExpression(p)) {
    const op = p.operatorToken.kind;
    const cmp =
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken ||
      op === ts.SyntaxKind.EqualsToken;
    const other = p.left === lit ? p.right : p.left;
    return cmp && nameRe.test(other.getText(sf));
  }
  return false;
}

/**
 * Count one file. Returns `{ dev, domain, tokens }`: dev hits, domain hits,
 * and every hit by token id (`dev:<id>` / `domain:<text>`).
 */
export function countDomainVocabulary(fileName, text) {
  const sf = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const dev = {};
  const domain = {};
  const visit = (n) => {
    if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) devHits(n.text, dev);
    else if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n) ||
      ts.isJsxText(n)
    ) {
      devHits(n.text, dev);
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
        if (DOMAIN_SET.has(n.text)) domain[n.text] = (domain[n.text] ?? 0) + 1;
        else if (
          DOMAIN_POSITIONAL.some(
            (d) => d.texts.includes(n.text) && inPosition(n, sf, d.name)
          )
        )
          domain[n.text] = (domain[n.text] ?? 0) + 1;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  const tokens = {};
  for (const [k, v] of Object.entries(dev)) tokens[`dev:${k}`] = v;
  for (const [k, v] of Object.entries(domain)) tokens[`domain:${k}`] = v;
  return { dev: sum(dev), domain: sum(domain), tokens };
}

/** Every scanned file under `roots` (absolute), sorted. */
export function listScannedFiles(roots) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
      } else if (
        e.isFile() &&
        /\.tsx?$/.test(e.name) &&
        !SKIP_FILE_RE.test(e.name)
      ) {
        out.push(p);
      }
    }
  };
  for (const r of roots) walk(r);
  return out.sort();
}

/**
 * Scan the backend at `repo`: per-file `{dev, domain}` (files with a hit only),
 * per-token totals, and the number of files read. Allowlisted files are read
 * (so the allowlist is measured) but not counted.
 */
export function scanAgnosticBackend(repo, roots = ROOTS) {
  const files = listScannedFiles(roots.map((r) => join(repo, r)));
  const perFile = new Map();
  const tokens = {};
  const allowlisted = {};
  for (const f of files) {
    const rel = f
      .slice(repo.length + 1)
      .split("\\")
      .join("/");
    const c = countDomainVocabulary(f, readFileSync(f, "utf8"));
    if (c.dev + c.domain === 0) continue;
    if (Object.hasOwn(ALLOWLIST, rel)) {
      allowlisted[rel] = c.dev + c.domain;
      continue;
    }
    perFile.set(rel, { dev: c.dev, domain: c.domain });
    for (const [k, v] of Object.entries(c.tokens))
      tokens[k] = (tokens[k] ?? 0) + v;
  }
  return { files: files.length, perFile, tokens, allowlisted };
}

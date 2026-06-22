#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// seed-agency-capabilities.mjs — apply the agency capability TEMPLATES to a pod.
//
// Reads the code-resident `.capability.json` templates and applies each through
// the ONE door (`POST /api/hub/capabilities/apply`) as an INLINE definition. We
// send the definition inline (not by templateKey) on purpose: a deployed pod
// resolves templateKey from its DB table / bundled image, and these templates
// are not there yet — inline apply works against any reachable pod today.
//
// With the container keystone, each apply now creates a `capabilities` CONTAINER
// named from the template and links its tools + skills as members — so they show
// up as real capabilities in the Capabilities app.
//
// Usage (from synap-backend/):
//   SYNAP_POD_URL=... SYNAP_HUB_API_KEY=... SYNAP_WORKSPACE_ID=... \
//     node scripts/seed-agency-capabilities.mjs
//
// Secret-backed templates are applied ONLY when their value is in the env:
//   UNIPILE_API_KEY=...   → also seeds the LinkedIn (Unipile) capability
//   TELEGRAM_BOT_TOKEN=...→ also seeds the Telegram (bridge) capability
// (Discord is provisioned separately via `synap bridge-setup`.)
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TPL_DIR = resolve(__dirname, "../templates/capabilities");

const POD_URL = (process.env.SYNAP_POD_URL || "").replace(/\/$/, "");
const API_KEY = process.env.SYNAP_HUB_API_KEY || "";
const WORKSPACE_ID = process.env.SYNAP_WORKSPACE_ID || "";

if (!POD_URL || !API_KEY || !WORKSPACE_ID) {
  console.error(
    "Missing env. Need SYNAP_POD_URL, SYNAP_HUB_API_KEY, SYNAP_WORKSPACE_ID.",
  );
  process.exit(1);
}

// The agency set. `params` carries any secret values (only applied when present).
const PLAN = [
  { key: "nango-gmail", needs: null, params: {} },
  { key: "nango-gdrive", needs: null, params: {} },
  { key: "nango-calendar", needs: null, params: {} },
  { key: "agency-skills", needs: null, params: {} },
  {
    key: "unipile-linkedin",
    needs: "UNIPILE_API_KEY",
    params: {
      unipileApiKey: process.env.UNIPILE_API_KEY,
      ...(process.env.UNIPILE_BASE_URL && { unipileBaseUrl: process.env.UNIPILE_BASE_URL }),
      ...(process.env.UNIPILE_ACCOUNT_ID && { unipileAccountId: process.env.UNIPILE_ACCOUNT_ID }),
    },
  },
  {
    key: "telegram-bridge",
    needs: "TELEGRAM_BOT_TOKEN",
    params: { telegramBotToken: process.env.TELEGRAM_BOT_TOKEN },
  },
];

function loadDefinition(key) {
  const raw = readFileSync(resolve(TPL_DIR, `${key}.capability.json`), "utf8");
  return JSON.parse(raw);
}

async function applyOne(key, params) {
  const definition = loadDefinition(key);
  const res = await fetch(`${POD_URL}/api/hub/capabilities/apply`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ definition, params, workspaceId: WORKSPACE_ID }),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, json, name: definition.name };
}

function summarize(json) {
  const c = json?.created ?? {};
  const container = c.container ? `${c.container.name} [${c.container.status}]` : "—";
  const tools = (c.tools ?? []).map((t) => `${t.name}(${t.status})`).join(", ") || "—";
  const skills = (c.skills ?? []).map((s) => `${s.name}(${s.status})`).join(", ") || "—";
  const playbooks = (c.playbooks ?? []).map((p) => `${p.name}(${p.status})`).join(", ") || "—";
  const proposals = (json?.proposals ?? []).length;
  return `container=${container} · tools=${tools} · skills=${skills} · playbooks=${playbooks} · proposals=${proposals}`;
}

async function main() {
  console.log(`Seeding agency capabilities → ${POD_URL} (workspace ${WORKSPACE_ID})\n`);
  const skipped = [];
  for (const item of PLAN) {
    if (item.needs && !process.env[item.needs]) {
      skipped.push(`${item.key} (set ${item.needs} to seed it)`);
      continue;
    }
    try {
      const r = await applyOne(item.key, item.params);
      if (r.ok) {
        console.log(`✓ ${item.key.padEnd(18)} ${summarize(r.json)}`);
      } else {
        console.log(`✗ ${item.key.padEnd(18)} HTTP ${r.status} — ${r.json.error || r.json.raw || "failed"}`);
      }
    } catch (err) {
      console.log(`✗ ${item.key.padEnd(18)} ${err.message}`);
    }
  }
  if (skipped.length) {
    console.log(`\nSkipped (no credential in env):`);
    for (const s of skipped) console.log(`  - ${s}`);
  }
  console.log(
    `\nNext: open the Capabilities app to see the containers, then connect accounts:` +
      `\n  • Google (Gmail/Drive/Calendar): Settings → Connectors → connect Google (Nango OAuth).` +
      `\n  • LinkedIn: provide UNIPILE_API_KEY and re-run; connect the LinkedIn account in Unipile.` +
      `\n  • Telegram/Discord: provision the bot token via the bridge (synap bridge-setup).`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); });

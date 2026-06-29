/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: synap-backend/templates/capabilities/*.capability.json
 * Regenerate: node packages/api/scripts/gen-bundled-templates.mjs
 *
 * WHY THIS EXISTS: the capability template library MUST be available at runtime
 * regardless of whether the deploy image bundled the templates/ directory. The
 * on-disk COPY proved fragile (a missing layer => an empty catalog => a hidden
 * door). Compiling the definitions into the bundle here makes discoverability
 * unconditional: tsup inlines this module, so the templates ship inside the
 * server binary and can never be "lost" by a Docker COPY or build cache.
 */
import type { CapabilityDefinition } from "@synap/playbooks";

const RAW = {
  "agency-skills": {
    key: "agency-skills",
    name: "Agency — AI Know-How",
    description:
      "The agency's AI know-how bundle: six instruction skills (prompt/doc skills injected into the agent's turn — no sandboxed code, no connector calls) that teach the agent how to draft outreach, draft replies, qualify replies, summarize threads, extract action items, and assemble a client brief. Plus two process playbooks (lead-outreach, client-onboarding) that sequence those skills + the connector tools into the §2 agency flows. Instruction skills are pure know-how: when the agent runs in a client's thread it gets that client as the subject (contextEntityId), and these skills shape WHAT it writes. Their `requires` lists name the connector tools the skill's output feeds into (e.g. draft-outreach feeds the LinkedIn send) — the tools come from the sibling capabilities (unipile-linkedin, nango-gmail, telegram-bridge); apply those to wire the links. Outbound actions remain proposal-gated and reversible.",
    params: [],
    vault: [],
    tools: [],
    skills: [
      {
        name: "draft-outreach",
        kind: "instruction",
        scope: "pod",
        description:
          "Write a personalized, non-salesy first outreach message to a lead, grounded in their LinkedIn profile and our agency's pitch. Output feeds the LinkedIn send (Unipile), which stays proposal-gated.",
        requires: ["unipile_linkedin"],
        code: '# Draft Outreach\n\nYou are writing the FIRST message to a lead we just connected with on LinkedIn. The goal is to start a genuine conversation, not to sell. A good first message earns a reply; a salesy one gets ignored.\n\n## Inputs you are given\n- The lead\'s LinkedIn profile (name, headline, current company, role, recent activity, location).\n- Our agency\'s pitch / positioning (what we do, who we help, the outcome we deliver).\n- Any prior context about why this lead was sourced (the list they came from, the angle).\n\n## How to write it\n1. **Open with them, not us.** Reference something specific and true from their profile — their role, a company milestone, a post they shared, a shared interest. Generic openers ("I came across your profile") are a tell; be specific enough that it could only have been written for this person.\n2. **One sentence of relevance.** Connect what they do to what we do, lightly. Show you understand their world.\n3. **A low-friction invitation.** Ask one easy, open question OR offer something small and useful (an idea, a resource). Never pitch the engagement in message one. No calendar links, no "hop on a call" yet.\n4. **Be brief.** 3–5 sentences. LinkedIn rewards short. If it reads like a template, rewrite it.\n5. **Match their register.** Mirror the lead\'s seniority and tone — peer-to-peer for founders/execs, warm and concrete for operators.\n\n## Hard rules\n- No flattery that isn\'t earned, no buzzwords ("synergy", "circle back", "game-changer").\n- No more than one ask. No links unless they\'re genuinely helpful.\n- Use the lead\'s first name once, naturally.\n- Never invent facts about the lead — only use what\'s in the profile.\n\n## Output\nReturn ONLY the message text, ready to review and send. No subject line (LinkedIn DMs have none), no preamble, no explanation. The operator reviews and edits before it sends.',
      },
      {
        name: "draft-reply",
        kind: "instruction",
        scope: "pod",
        description:
          "Draft a proposed reply to a client's mail or Telegram thread, in the client's voice and with full client context. Output feeds the Gmail/Telegram send, which stays proposal-gated and operator-reviewed.",
        requires: ["gmail", "telegram"],
        code: "# Draft Reply\n\nYou are drafting a reply on behalf of the operator, inside a specific client's communication thread (mail or Telegram). The operator will review and edit before it sends — your job is to get them 90% of the way with a reply they can approve in one read.\n\n## Inputs you are given\n- The full thread (most recent message last) — mail or Telegram.\n- The client's context: who they are, the engagement, recent activity, known preferences (e.g. \"prefers async\", \"likes bullet points\", tone).\n- Any open commitments or deadlines relevant to this thread.\n\n## How to write it\n1. **Answer what was actually asked.** Identify the concrete asks/questions in the latest message and address each. Don't dodge, don't pad.\n2. **Match the client's voice and channel.** Mail can be a touch more formal; Telegram is shorter and warmer. Mirror how this client and operator have written earlier in the thread.\n3. **Be specific and committed.** If we owe something, say what and by when. If we need info, ask precisely. Avoid vague reassurance (\"we'll look into it\").\n4. **Acknowledge, then move forward.** One line of acknowledgement if warranted, then the substance. No long apologies.\n5. **Surface, don't hide, uncertainty.** If a question can't be answered without info the operator holds, draft the reply with a clearly-marked placeholder like [confirm timeline with operator] rather than guessing.\n\n## Hard rules\n- Never commit to a date, price, or scope that isn't supported by the thread or client context — flag it for the operator instead.\n- Don't invent facts about the engagement.\n- Keep it tight: clients value brevity. Cut anything that doesn't serve the reply.\n\n## Output\nReturn ONLY the reply body, ready to review and send. For mail, you MAY include a one-line subject ONLY if starting a new subject; otherwise omit it. No commentary about your reasoning — just the draft.",
      },
      {
        name: "qualify-reply",
        kind: "instruction",
        scope: "pod",
        description:
          "Classify a lead's or client's reply (interested / not-interested / needs-info) and state the single recommended next step. Pure classification — no tools, no sends.",
        code: '# Qualify Reply\n\nYou are triaging an inbound reply from a lead or client so the operator (and the automation) knows what to do next. Be decisive and honest — a wrong "interested" wastes outreach, a wrong "not" loses a deal.\n\n## Inputs you are given\n- The reply text.\n- The thread it replied to (what we asked / sent).\n- Light context on the lead/client and where they are in the flow.\n\n## Classify into exactly ONE label\n- **interested** — they signal openness: a question back, a yes, a request to talk, curiosity about what we do. Lukewarm-but-engaged counts as interested.\n- **not-interested** — a clear no, "not now", "please remove me", silence-with-decline, or an out-of-office that closes the door. Respect it.\n- **needs-info** — they\'re not saying yes or no; they need something from us first (pricing, a clarification, proof, a different contact). The ball is in our court.\n\n## How to decide\n- Read intent, not just politeness. "Thanks, this is interesting, but..." is usually not-interested or needs-info depending on the "but".\n- When genuinely ambiguous, prefer **needs-info** over guessing interested/not — it routes to a human-shaped next step instead of a premature send.\n- Detect explicit opt-outs and ALWAYS classify them not-interested, regardless of tone.\n\n## Output\nReturn a compact result with exactly these fields:\n- `label`: one of interested | not-interested | needs-info\n- `confidence`: low | medium | high\n- `reason`: one sentence citing the signal in their reply.\n- `next_step`: one concrete recommended action (e.g. "send the personalized first message", "draft a reply answering their pricing question", "mark not-interested and stop outreach", "promote to a deal and start onboarding").\n\nDo not take the action — only recommend it. Every send remains proposal-gated and operator-reviewed.',
      },
      {
        name: "summarize-thread",
        kind: "instruction",
        scope: "pod",
        description:
          "Condense a mail or Telegram thread into the key points plus the open questions. Pure know-how — no tools.",
        code: "# Summarize Thread\n\nYou are condensing a communication thread (mail or Telegram) so the operator can grasp it in seconds and pick up where it left off. Accuracy and brevity both matter — a summary that hides an open question is worse than none.\n\n## Inputs you are given\n- The full thread, oldest to newest.\n- Light client/lead context (who the parties are).\n\n## What to produce\n1. **TL;DR** — one or two sentences: what this thread is about and where it stands right now.\n2. **Key points** — 3–6 bullets of the substance: decisions made, commitments given (by us and by them), facts established, dates/numbers that matter. Attribute who said what when it's load-bearing.\n3. **Open questions / awaiting** — the things still unresolved: what we're waiting on from them, what they're waiting on from us, any unanswered question. Be explicit about whose court the ball is in.\n4. **Recommended next step** — one line, only if obvious from the thread.\n\n## Rules\n- Only state what's in the thread. Never infer commitments that weren't made.\n- Preserve specifics — exact dates, amounts, names — don't blur them into \"soon\" or \"some\".\n- If the thread is short, keep the summary shorter than the thread; don't pad.\n\n## Output\nReturn the four sections above as plain markdown. No preamble.",
      },
      {
        name: "extract-action-items",
        kind: "instruction",
        scope: "pod",
        description:
          "Turn a thread (mail/Telegram) into a list of concrete, assignable tasks. Pure know-how — no tools.",
        code: '# Extract Action Items\n\nYou are turning a communication thread into a clean list of concrete tasks the team can act on. A good action item is unambiguous about WHAT and WHO; a vague one ("follow up") is useless.\n\n## Inputs you are given\n- The full thread (mail or Telegram).\n- Client/lead context and who\'s on our side.\n\n## How to extract\n1. Read the whole thread, then pull out every commitment, request, and unresolved decision that requires someone to DO something.\n2. Phrase each as an imperative starting with a verb: "Send the revised proposal", "Confirm the launch date with the client", "Draft the onboarding doc".\n3. Assign an owner where the thread makes it clear (us vs the client vs a named person). If unclear, mark owner as `unassigned`.\n4. Capture a due date / timeframe ONLY if the thread states or strongly implies one — never invent deadlines.\n5. Note a one-clause source so the operator can trace it back ("client asked for pricing in last message").\n\n## Rules\n- One task per item — split compound asks ("send the deck and book a call") into two.\n- Don\'t manufacture tasks the thread doesn\'t support. If there are no action items, say so plainly.\n- Keep client-side and our-side tasks distinct so the operator sees what we owe vs what we\'re waiting on.\n\n## Output\nReturn a list where each item has: `task` (imperative), `owner` (us | client | named person | unassigned), `due` (date/timeframe or null), `source` (one clause). These will be proposed as task entities linked to the client — every write stays proposal-gated.',
      },
      {
        name: "client-brief",
        kind: "instruction",
        scope: "pod",
        description:
          "Assemble a client's context — who they are, the engagement, recent activity — at the start of an agent turn so the agent acts with full grounding. Pure know-how — no tools.",
        code: "# Client Brief\n\nYou are assembling a fast, accurate briefing on a client at the START of a turn, so everything you do next (drafting a reply, planning work, answering the operator) is grounded in who this client actually is. Think of it as reading the file before the meeting.\n\n## Inputs you are given\n- The client entity (name, company, the engagement, status).\n- Recent activity: latest messages across their channels, recent tasks/deals, recent notes.\n- Any stored preferences or facts about how they like to work.\n\n## What to assemble\n1. **Who they are** — client/company name, the relationship (deal stage or active engagement), and the one-line of what we do for them.\n2. **Where things stand** — the current state of the engagement: what's in flight, what's blocked, what's recently shipped or decided.\n3. **Recent activity** — the last few meaningful touchpoints (a mail, a Telegram exchange, a meeting), newest first, each one clause.\n4. **Open items** — what we owe them and what we're waiting on (pull from open tasks / unresolved threads).\n5. **How to work with them** — known preferences: tone, channel, cadence, sensitivities (e.g. \"prefers async\", \"wants weekly updates\", \"don't loop in X\").\n\n## Rules\n- Only state what the pod actually knows — never fabricate engagement details or preferences.\n- Lead with what's most decision-relevant for the turn ahead; cut stale or irrelevant history.\n- Keep it scannable — the agent reads this in one pass before acting.\n\n## Output\nReturn the five sections as compact markdown. This is the agent's grounding for the turn; it is not shown to the client.",
      },
    ],
    playbooks: [
      {
        name: "Lead Outreach",
        description:
          "Flow 1 — Lead acquisition via LinkedIn outreach from an imported list. The agent works the list one lead at a time, each step proposal-gated and operator-reviewed.",
        goalTemplate:
          "Work a list of imported leads into qualified conversations via LinkedIn. For each lead: (1) find their LinkedIn profile via Unipile profile search; (2) send a connection request (proposal-gated); (3) wait for acceptance (delay / scheduled re-check); (4) on acceptance, use the draft-outreach skill to write a personalized, non-salesy first message from the lead's profile + our agency pitch, and propose it for the operator to review and send; (5) on reply, use qualify-reply to classify interest and recommend the next step — if interested, promote the lead to a deal/client and trigger the client-onboarding flow. Every outbound action stays proposal-gated and reversible.",
        params: [
          {
            name: "leadSource",
            label: "Lead source",
            type: "text",
            required: false,
            description:
              "Where this batch of leads came from (e.g. the monthly CSV name or the campaign angle) — used to ground the outreach.",
          },
        ],
        inputStrategy: {
          kind: "entity-list",
          description:
            "Bound to a list of lead entities (e.g. imported from a monthly CSV); the agent iterates one lead per cycle.",
        },
        channelSpec: {
          kind: "session",
          description:
            "Runs in the lead-outreach session; outreach drafts and qualification post into the session for review.",
        },
        expectedOutputs: [
          {
            kind: "entity",
            profileSlug: "person",
            description:
              "LinkedIn profiles matched and enriched as person entities.",
          },
          {
            kind: "note",
            description:
              "Connection requests and sent first messages recorded for the activity timeline.",
          },
          {
            kind: "deal",
            description:
              "Interested leads promoted to deals for the onboarding flow.",
          },
        ],
        schedule: null,
        executor: "is-agent",
        status: "draft",
      },
      {
        name: "Client Onboarding",
        description:
          "Flow 3 — One command (a won deal, or /link-client) sets up the whole client context. Idempotent: re-running ensures the pieces exist without duplicating them. Every creation is proposal-gated.",
        goalTemplate:
          "Onboard a client into a complete working context. Steps: (1) ensure the client ENTITY exists (create it from the deal/name if absent); (2) ensure the client ROOM + threads exist — a client-comms thread for inbound mail/Telegram and a team+AI thread for work; (3) start a per-client SESSION bound to the client (instantiate with subjectId = the client entity) as the hub linking their mail/Drive/tasks/messages; (4) attach the DEFAULT automations for this client (e.g. draft-reply on inbound mail, intro message on first channel creation) — opt-in per client; (5) link the client's Google DRIVE folder (create + share if absent) via the gdrive tool; (6) link the client's MAIL (the dedicated per-engagement address); (7) PIN the client context to the channel — the Drive link and a client-brief (use the client-brief skill) so every turn starts grounded. Each step is proposal-gated and reversible; re-running is idempotent.",
        params: [
          {
            name: "clientName",
            label: "Client name",
            type: "text",
            required: true,
            description:
              "The client to onboard (used to find-or-create the client entity).",
          },
        ],
        inputStrategy: {
          kind: "entity",
          description:
            "Bound to a single client entity (the subject); the session is instantiated with this client as subjectId.",
        },
        channelSpec: {
          kind: "client-room",
          description:
            "Sets up the client's room with a client-comms thread (inbound mail/Telegram) and a team+AI thread (work).",
        },
        expectedOutputs: [
          {
            kind: "entity",
            profileSlug: "client",
            description: "The client entity, ensured.",
          },
          {
            kind: "channel",
            description: "The client room + client-comms and team+AI threads.",
          },
          {
            kind: "note",
            description: "Pinned client context: Drive link + client-brief.",
          },
        ],
        schedule: null,
        executor: "is-agent",
        status: "draft",
      },
    ],
  },
  "discord-bot": {
    key: "discord-bot",
    name: "Discord Bot",
    description:
      "Post messages to a Discord channel via a Discord bot (API-key style auth). Stores the bot token in the vault, registers one HTTP API tool that authenticates with Discord's `Authorization: Bot <token>` header against the Discord v10 API, and seeds one proposal-gated code skill that sends a channel message and records it as a note. Rides on the shipped `vault://` executor: the applier remaps the tool's template-local vault ref to a runtime `vault://<id>`, and the dispatcher resolves the tool by NAME server-side and injects the vaulted token. PRECONDITION: a Discord application with a Bot user, the bot invited to the target server with the Send Messages permission and the Message Content intent enabled. Pass the bot token as `discordBotToken` and (optionally) a default `channelId`.",
    params: [
      {
        name: "discordBotToken",
        label: "Discord bot token",
        type: "text",
        required: true,
        description:
          "The Discord bot token (Developer Portal -> Bot -> Token). Stored server-encrypted in the vault; never persisted in the template.",
      },
      {
        name: "channelId",
        label: "Default Discord channel id",
        type: "text",
        required: false,
        description:
          "Optional default channel id the bot posts to when a skill call omits channelId. The numeric snowflake id of the target channel.",
      },
    ],
    vault: [
      {
        ref: "discordBotTokenSecret",
        name: "{{name}} Discord bot token",
        value: "{{discordBotToken}}",
        type: "api_key",
        description: "Discord bot token for the discord_bot connector.",
      },
    ],
    tools: [
      {
        name: "discord_bot",
        kind: "api",
        description:
          "Authenticated HTTP access to the Discord v10 API. The applier injects the vaulted bot token into the Authorization header as `Bot <token>`; its credentialRef is remapped to the runtime vault://<id> at apply time.",
        credentialRef: "discordBotTokenSecret",
        executor: "is-agent",
        config: {
          baseUrl: "https://discord.com/api/v10",
          auth: { in: "header", name: "Authorization", prefix: "Bot " },
        },
      },
    ],
    skills: [
      {
        name: "discord_send_message",
        kind: "code",
        scope: "pod",
        description:
          "Sends a message to a Discord channel via the bot, then records the post as a note entity (proposal-gated). Args: { content: string, channelId?: string }. The bot token is injected server-side from the vault; the dispatcher resolves the discord_bot tool by name.",
        requires: ["discord_bot"],
        executionMode: "async",
        timeoutSeconds: 60,
        parameters: { content: "string", channelId: "string?" },
        code: "// Post a message to a Discord channel via the bot, then record a note.\n// Executor wraps this body as (async (args, context) => { <code> }); use args\n// directly and `return` the result. callProvider(tool, method, path, body?)\n// runs the required tool through the dispatcher (resolves the tool by NAME\n// 'discord_bot', injects the vaulted bot token as Authorization: Bot <token>,\n// uses the tool's config.baseUrl = https://discord.com/api/v10).\nconst content = String(args?.content ?? '').trim();\nif (!content) throw new Error('discord_send_message: content is required');\nconst channelId = String(args?.channelId ?? '{{channelId}}').trim();\nif (!channelId) throw new Error('discord_send_message: channelId is required (pass it or set a default in the template)');\n\n// Discord v10 create-message endpoint.\nconst res = await callProvider('discord_bot', 'POST', '/channels/' + encodeURIComponent(channelId) + '/messages', { content });\nconst ok = res?.status ? res.status >= 200 && res.status < 300 : true;\nconst payload = res?.body ?? res;\nconst messageId = payload?.id ?? null;\n\nawait propose.entity({\n  profileSlug: 'note',\n  title: 'Discord message ' + (ok ? 'sent' : 'attempted') + ' -> #' + channelId,\n  properties: {\n    action: 'discord_send_message',\n    channelId: channelId,\n    content: content,\n    messageId: messageId,\n    status: res?.status ?? null,\n    success: ok,\n    source: 'discord-bot'\n  },\n  reasoning: 'Recorded the outbound Discord message for the activity timeline.'\n});\nreturn { success: ok, channelId: channelId, messageId: messageId, status: res?.status ?? null };\n",
      },
    ],
  },
  "generic-apikey": {
    key: "generic-apikey",
    name: "Generic API-Key Connector",
    description:
      "Provider-neutral demonstration of the capability-template shape: stores one API key in the vault, registers one HTTP API tool that authenticates with it, and seeds one code skill that fetches from the provider and proposes the results as entities. Customize via the {{baseUrl}}, {{apiKey}}, and {{entityProfile}} params — no provider is hardcoded.",
    params: [
      {
        name: "apiKey",
        label: "API key",
        type: "text",
        required: true,
        description:
          "The bearer API key for the provider. Stored server-encrypted in the vault; never persisted in the template.",
      },
      {
        name: "baseUrl",
        label: "Base URL",
        type: "text",
        required: true,
        description:
          "The provider's API base URL, e.g. https://api.example.com/v1",
      },
      {
        name: "entityProfile",
        label: "Target entity profile",
        type: "text",
        required: false,
        default: "note",
        description: "The profileSlug the skill proposes fetched records as.",
      },
    ],
    vault: [
      {
        ref: "apiKeySecret",
        name: "{{name}} API key",
        value: "{{apiKey}}",
        type: "api_key",
        description: "API key for the generic-apikey connector.",
      },
    ],
    tools: [
      {
        name: "generic_api",
        kind: "api",
        description: "Authenticated HTTP access to the provider API.",
        credentialRef: "apiKeySecret",
        executor: "is-agent",
        config: {
          baseUrl: "{{baseUrl}}",
          auth: { in: "header", name: "Authorization", prefix: "Bearer " },
        },
      },
    ],
    skills: [
      {
        name: "{{name}} fetch-and-propose",
        kind: "code",
        scope: "pod",
        description:
          "Fetches records from the provider API and proposes each as an entity (proposal-gated). Calls the required tool by name via callProvider('generic_api', ...).",
        requires: ["generic_api"],
        executionMode: "async",
        timeoutSeconds: 60,
        parameters: { path: "string?", entityProfile: "string?" },
        code: "// Generic fetch -> propose loop. The skill body is a STATEMENT body (no `export\n// default`); the executor wraps it as (async function(args, context){ <code> }).\n// callProvider is POSITIONAL: callProvider(provider, method, path, body?) where\n// `provider` is the required tool's NAME ('generic_api') — the dispatcher resolves\n// it to the tool's credentialRef server-side and injects the vaulted API key. No\n// providerRef arg needed. propose.entity REQUIRES `title` (not `name`) and routes\n// the write through checkPermissionOrPropose.\nconst path = args.path || '/records';\nconst profileSlug = args.entityProfile || 'note';\nconst res = await callProvider('generic_api', 'GET', path);\nconst data = res && res.body !== undefined ? res.body : res;\nconst records = Array.isArray(data)\n  ? data\n  : (data && Array.isArray(data.data) ? data.data : (data && data.records) || []);\nlet proposed = 0;\nfor (const record of records) {\n  await propose.entity({\n    profileSlug,\n    title: String((record && (record.name || record.title || record.id)) || 'record'),\n    properties: record,\n  });\n  proposed++;\n}\nreturn { proposed };\n",
      },
    ],
  },
  "nango-gmail": {
    key: "nango-gmail",
    name: "Nango — Gmail",
    description:
      "Send follow-up email via Gmail through Nango OAuth. Registers one provider tool whose credentialRef is the stable nango://gmail ref (Nango holds the OAuth credential — no vault secret), and seeds one proposal-gated code skill that sends an email via the Gmail API (users.messages.send) and notes the send as a `note`. Grounded in synap-backend's NangoConnector.proxyRequest (Connection-Id + Provider-Config-Key, host/proxy<path>) and external-dispatch's nango:// handler. PRECONDITION: a Nango integration with providerConfigKey 'gmail' must already exist and the acting user must have connected their Google account via Settings -> Connectors; the dispatcher resolves the user's most-recent gmail connection automatically.",
    params: [],
    vault: [],
    tools: [
      {
        name: "gmail",
        kind: "provider",
        description:
          "Gmail access through Nango. credentialRef nango://gmail resolves the user's Google connection (Connection-Id + Provider-Config-Key) and proxies the request to the Gmail API.",
        credentialRef: "nango://gmail",
        executor: "is-agent",
        config: { providerConfigKey: "gmail" },
      },
    ],
    skills: [
      {
        name: "gmail_send",
        kind: "code",
        scope: "pod",
        description:
          "Sends an email via Gmail (Nango OAuth) and notes the send as a note entity (proposal-gated). Args: { to: string, subject: string, body: string }.",
        requires: ["gmail"],
        executionMode: "async",
        timeoutSeconds: 60,
        parameters: { to: "string", subject: "string", body: "string" },
        code: "// Send a Gmail message via Nango OAuth, then record a note.\n// Executor wraps this body as (async function(args, context){ <code> }); use args\n// directly and `return`. callProvider('gmail', 'POST',\n// '/gmail/v1/users/me/messages/send', { raw }) goes through the dispatcher by\n// tool NAME ('gmail'): the dispatcher resolves the tool's credentialRef\n// (nango://gmail), the nango:// handler resolves the user's Google connection and\n// proxies to the Gmail API. (Passing the raw credentialRef 'nango://gmail' still\n// works too — back-compat.)\nconst to = String(args?.to ?? '').trim();\nconst subject = String(args?.subject ?? '').trim();\nconst bodyText = String(args?.body ?? '');\nif (!to) throw new Error('gmail_send: to is required');\nif (!subject) throw new Error('gmail_send: subject is required');\n\n// Build an RFC 2822 message and base64url-encode it (Gmail raw field).\n// No Buffer/btoa in the isolate, so encode UTF-8 -> base64 manually.\nconst mime = [\n  'To: ' + to,\n  'Subject: ' + subject,\n  'MIME-Version: 1.0',\n  'Content-Type: text/plain; charset=\"UTF-8\"',\n  '',\n  bodyText\n].join('\\r\\n');\n\nconst B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';\nconst utf8Bytes = (str) => {\n  const out = [];\n  for (let i = 0; i < str.length; i++) {\n    let c = str.charCodeAt(i);\n    if (c < 0x80) out.push(c);\n    else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }\n    else if (c >= 0xd800 && c <= 0xdbff) {\n      const c2 = str.charCodeAt(++i);\n      c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);\n      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));\n    } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }\n  }\n  return out;\n};\nconst base64 = (bytes) => {\n  let s = '';\n  for (let i = 0; i < bytes.length; i += 3) {\n    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];\n    s += B64[b0 >> 2];\n    s += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];\n    s += b1 === undefined ? '=' : B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];\n    s += b2 === undefined ? '=' : B64[b2 & 63];\n  }\n  return s;\n};\nconst raw = base64(utf8Bytes(mime)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');\n\nconst res = await callProvider('gmail', 'POST', '/gmail/v1/users/me/messages/send', { raw });\nconst ok = res?.status ? res.status >= 200 && res.status < 300 : true;\nconst messageId = res?.body?.id ?? null;\n\nawait propose.entity({\n  profileSlug: 'note',\n  title: 'Email ' + (ok ? 'sent' : 'attempted') + ' -> ' + to + ': ' + subject,\n  properties: {\n    action: 'gmail_send',\n    to,\n    subject,\n    gmailMessageId: messageId,\n    status: res?.status ?? null,\n    success: ok,\n    source: 'nango-gmail'\n  },\n  reasoning: 'Recorded the outbound follow-up email for the activity timeline.'\n});\nreturn { success: ok, to, subject, gmailMessageId: messageId, status: res?.status ?? null };\n",
      },
    ],
  },
  "nango-google": {
    key: "nango-google",
    name: "Nango — Google Workspace",
    description:
      "Google Workspace (Gmail + Calendar + Drive) through ONE Nango OAuth connection. Registers a single provider tool whose credentialRef is the stable nango://google ref (Nango holds the OAuth credential — no vault secret) and seeds five skills across the three Google APIs. Gmail calls set Nango's Base-Url-Override to gmail.googleapis.com; Calendar/Drive use the provider-default host www.googleapis.com. Grounded in NangoConnector.proxyRequest (Connection-Id + Provider-Config-Key, optional Base-Url-Override) and external-dispatch's nango:// handler. PRECONDITION: a Nango integration with providerConfigKey 'google' (scopes for gmail.send, gmail.readonly, calendar, drive.readonly) must exist and the acting user must have connected their Google account via Settings -> Connectors; the dispatcher resolves the user's most-recent google connection automatically. Writes (gmail_send, calendar_create) are side-effecting and route through the capability-execution gate (which may auto-run or propose depending on the actor); the skills detect a proposal envelope and report 'queued for approval' rather than falsely claiming success. Reads (gmail_search, calendar_list, drive_search) return data inline.",
    params: [],
    vault: [],
    tools: [
      {
        name: "google",
        kind: "provider",
        description:
          "Google Workspace access through Nango. credentialRef nango://google resolves the user's Google connection (Connection-Id + Provider-Config-Key) and proxies the request to the relevant Google API (Gmail via Base-Url-Override, Calendar/Drive via the provider default).",
        credentialRef: "nango://google",
        executor: "is-agent",
        config: { providerConfigKey: "google" },
      },
    ],
    skills: [
      {
        name: "gmail_send",
        kind: "code",
        scope: "pod",
        description:
          "Sends an email via Gmail (Nango OAuth) and notes the send as a note entity (proposal-gated). Args: { to: string, subject: string, body: string }.",
        requires: ["google"],
        executionMode: "async",
        timeoutSeconds: 60,
        parameters: { to: "string", subject: "string", body: "string" },
        code: "// Send a Gmail message through the unified Google connection (Nango OAuth).\n// callProvider('google', ...) routes by tool NAME to the nango://google\n// connection; the 5th arg baseUrlOverride points THIS call at gmail.googleapis.com\n// (Calendar/Drive use the provider default www.googleapis.com — no override).\nconst GMAIL_HOST = 'https://gmail.googleapis.com';\nconst to = String(args?.to ?? '').trim();\nconst subject = String(args?.subject ?? '').trim();\nconst bodyText = String(args?.body ?? '');\nif (!to) throw new Error('gmail_send: to is required');\nif (!subject) throw new Error('gmail_send: subject is required');\n\nconst mime = [\n  'To: ' + to,\n  'Subject: ' + subject,\n  'MIME-Version: 1.0',\n  'Content-Type: text/plain; charset=\"UTF-8\"',\n  '',\n  bodyText\n].join('\\r\\n');\n\nconst B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';\nconst utf8Bytes = (str) => {\n  const out = [];\n  for (let i = 0; i < str.length; i++) {\n    let c = str.charCodeAt(i);\n    if (c < 0x80) out.push(c);\n    else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }\n    else if (c >= 0xd800 && c <= 0xdbff) {\n      const c2 = str.charCodeAt(++i);\n      c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);\n      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));\n    } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }\n  }\n  return out;\n};\nconst base64 = (bytes) => {\n  let s = '';\n  for (let i = 0; i < bytes.length; i += 3) {\n    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];\n    s += B64[b0 >> 2];\n    s += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];\n    s += b1 === undefined ? '=' : B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];\n    s += b2 === undefined ? '=' : B64[b2 & 63];\n  }\n  return s;\n};\nconst raw = base64(utf8Bytes(mime)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');\n\nconst res = await callProvider('google', 'POST', '/gmail/v1/users/me/messages/send', { raw }, { baseUrlOverride: GMAIL_HOST });\n// The capability-execution gate may return a PROPOSAL envelope ({ proposed,\n// proposalId }) with NO http status instead of executing. When proposed, that\n// proposal IS the record — return early WITHOUT also filing a note (no\n// double-proposal); the send is logged on approval-replay.\nif (res?.proposed === true) {\n  return { success: false, proposed: true, proposalId: res?.proposalId ?? null, to, subject };\n}\n// Executed: treat \"no status\" as NOT-sent (never optimistically claim success).\nconst ok = typeof res?.status === 'number' && res.status >= 200 && res.status < 300;\nconst messageId = res?.body?.id ?? null;\n\nawait propose.entity({\n  profileSlug: 'note',\n  title: 'Email ' + (ok ? 'sent' : 'attempted') + ' -> ' + to + ': ' + subject,\n  properties: { action: 'gmail_send', to, subject, gmailMessageId: messageId, status: res?.status ?? null, success: ok, source: 'nango-google' },\n  reasoning: 'Recorded the outbound email for the activity timeline.'\n});\nreturn { success: ok, proposed: false, to, subject, gmailMessageId: messageId, status: res?.status ?? null };",
      },
      {
        name: "gmail_search",
        kind: "code",
        scope: "pod",
        description:
          "Searches Gmail and returns enriched results (subject, from, date, snippet) per hit. Args: { query?: string (Gmail search syntax), maxResults?: number }.",
        requires: ["google"],
        executionMode: "sync",
        timeoutSeconds: 60,
        parameters: { query: "string", maxResults: "number" },
        code: "// Search Gmail and return enriched headers (Subject/From/Date) for each hit.\n// Read-only: lists message ids, then fetches metadata per id (bounded).\nconst GMAIL_HOST = 'https://gmail.googleapis.com';\nconst q = String(args?.query ?? '').trim();\nconst maxResults = Math.min(Math.max(1, Number(args?.maxResults ?? 10) || 10), 25);\nconst listPath = '/gmail/v1/users/me/messages?maxResults=' + maxResults + (q ? '&q=' + encodeURIComponent(q) : '');\nconst listRes = await callProvider('google', 'GET', listPath, undefined, { baseUrlOverride: GMAIL_HOST });\nconst ids = (listRes?.body?.messages ?? []).map((m) => m.id);\nconst results = [];\nfor (const id of ids) {\n  try {\n    const mPath = '/gmail/v1/users/me/messages/' + id + '?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date';\n    const mRes = await callProvider('google', 'GET', mPath, undefined, { baseUrlOverride: GMAIL_HOST });\n    const headers = mRes?.body?.payload?.headers ?? [];\n    const h = (name) => { const f = headers.find((x) => (x.name || '').toLowerCase() === name); return f ? f.value : null; };\n    results.push({ id, subject: h('subject'), from: h('from'), date: h('date'), snippet: mRes?.body?.snippet ?? null });\n  } catch (e) { results.push({ id, error: String(e) }); }\n}\nreturn { query: q, count: results.length, results };",
      },
      {
        name: "calendar_list",
        kind: "code",
        scope: "pod",
        description:
          "Lists upcoming Google Calendar events ordered by start time. Args: { calendarId?: string (default 'primary'), timeMin?: RFC3339, maxResults?: number }.",
        requires: ["google"],
        executionMode: "sync",
        timeoutSeconds: 60,
        parameters: {
          calendarId: "string",
          timeMin: "string",
          maxResults: "number",
        },
        code: "// List upcoming Google Calendar events (read-only). Uses the provider-default\n// host www.googleapis.com (no baseUrlOverride needed for Calendar).\nconst maxResults = Math.min(Math.max(1, Number(args?.maxResults ?? 10) || 10), 50);\nconst timeMin = String(args?.timeMin ?? '').trim() || new Date().toISOString();\nconst calendarId = String(args?.calendarId ?? 'primary').trim() || 'primary';\nconst path = '/calendar/v3/calendars/' + encodeURIComponent(calendarId) + '/events?singleEvents=true&orderBy=startTime&maxResults=' + maxResults + '&timeMin=' + encodeURIComponent(timeMin);\nconst res = await callProvider('google', 'GET', path);\nconst events = (res?.body?.items ?? []).map((e) => ({ id: e.id, summary: e.summary ?? null, start: e.start ?? null, end: e.end ?? null, location: e.location ?? null, htmlLink: e.htmlLink ?? null }));\nreturn { calendarId, count: events.length, events };",
      },
      {
        name: "calendar_create",
        kind: "code",
        scope: "pod",
        description:
          "Creates a Google Calendar event and notes it (proposal-gated). Args: { summary: string, start: RFC3339, end: RFC3339, description?: string, location?: string, calendarId?: string }.",
        requires: ["google"],
        executionMode: "async",
        timeoutSeconds: 60,
        parameters: {
          summary: "string",
          start: "string",
          end: "string",
          description: "string",
          location: "string",
          calendarId: "string",
        },
        code: "// Create a Google Calendar event (side-effecting write). RFC3339 start/end.\nconst summary = String(args?.summary ?? '').trim();\nif (!summary) throw new Error('calendar_create: summary is required');\nconst start = String(args?.start ?? '').trim();\nconst end = String(args?.end ?? '').trim();\nif (!start) throw new Error('calendar_create: start is required (RFC3339, e.g. 2026-07-01T15:00:00Z)');\nif (!end) throw new Error('calendar_create: end is required (RFC3339)');\nconst calendarId = String(args?.calendarId ?? 'primary').trim() || 'primary';\nconst event = { summary, start: { dateTime: start }, end: { dateTime: end } };\nif (args?.description) event.description = String(args.description);\nif (args?.location) event.location = String(args.location);\nconst res = await callProvider('google', 'POST', '/calendar/v3/calendars/' + encodeURIComponent(calendarId) + '/events', event);\n// Proposed → the proposal is the record; return early without a duplicate note.\nif (res?.proposed === true) {\n  return { success: false, proposed: true, proposalId: res?.proposalId ?? null, summary };\n}\nconst ok = typeof res?.status === 'number' && res.status >= 200 && res.status < 300;\nconst eventId = res?.body?.id ?? null;\nconst htmlLink = res?.body?.htmlLink ?? null;\nawait propose.entity({\n  profileSlug: 'note',\n  title: 'Calendar event ' + (ok ? 'created' : 'attempted') + ': ' + summary,\n  properties: { action: 'calendar_create', summary, start, end, eventId, htmlLink, status: res?.status ?? null, success: ok, source: 'nango-google' },\n  reasoning: 'Recorded the created calendar event for the activity timeline.'\n});\nreturn { success: ok, proposed: false, summary, eventId, htmlLink, status: res?.status ?? null };",
      },
      {
        name: "drive_search",
        kind: "code",
        scope: "pod",
        description:
          "Searches Google Drive files by name and returns id/name/mimeType/webViewLink. Args: { query?: string, maxResults?: number }.",
        requires: ["google"],
        executionMode: "sync",
        timeoutSeconds: 60,
        parameters: { query: "string", maxResults: "number" },
        code: "// Search Google Drive files by name (read-only). Provider-default host.\nconst q = String(args?.query ?? '').trim();\nconst pageSize = Math.min(Math.max(1, Number(args?.maxResults ?? 10) || 10), 50);\nconst params = ['pageSize=' + pageSize, 'fields=' + encodeURIComponent('files(id,name,mimeType,webViewLink,modifiedTime)')];\nif (q) { const safe = q.replace(/'/g, ''); params.push('q=' + encodeURIComponent(\"name contains '\" + safe + \"'\")); }\nconst path = '/drive/v3/files?' + params.join('&');\nconst res = await callProvider('google', 'GET', path);\nconst files = (res?.body?.files ?? []).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, webViewLink: f.webViewLink ?? null, modifiedTime: f.modifiedTime ?? null }));\nreturn { query: q, count: files.length, files };",
      },
    ],
  },
  "telegram-bridge": {
    key: "telegram-bridge",
    name: "Telegram Bridge",
    description:
      "Telegram two-way messaging via an EXTERNAL bridge gateway (the Telegram/Discord/WhatsApp bridge worker that lives OUTSIDE this repo). This template represents the bridge connection: it stores the bridge bot token in the vault and registers one external tool whose credentialRef is remapped to the runtime vault://<id> at apply time. Inbound Telegram messages are delivered by the bridge into the client's entity-bound channel (inbound-recorder substrate, shipped); outbound sends are dispatched by the bridge against this connection. PRECONDITION: a Telegram bot (BotFather) added to the target groups, and the external bridge gateway configured with this same token. Pass the bot token as telegramBotToken. Outbound send code skills are NOT seeded here — the bridge owns delivery; this template establishes the connection + auth.",
    params: [
      {
        name: "telegramBotToken",
        label: "Telegram bridge bot token",
        type: "text",
        required: true,
        description:
          "The Telegram bot token (BotFather) used by the external bridge gateway. Stored server-encrypted in the vault; never persisted in the template.",
      },
    ],
    vault: [
      {
        ref: "telegramBotTokenSecret",
        name: "{{name}} Telegram bridge bot token",
        value: "{{telegramBotToken}}",
        type: "api_key",
        description:
          "Telegram bot token for the external bridge gateway (telegram connector).",
      },
    ],
    tools: [
      {
        name: "telegram",
        kind: "external",
        description:
          "Telegram messaging via the external bridge gateway. The bridge holds the connection; this tool's credentialRef is remapped to the runtime vault://<id> at apply time so the bridge token resolves server-side. Inbound is delivered by the bridge into the client's channel; outbound sends are dispatched by the bridge.",
        credentialRef: "telegramBotTokenSecret",
        executor: "external-agent",
        config: { transport: "bridge", externalSource: "telegram" },
      },
    ],
    skills: [],
  },
  "unipile-linkedin": {
    key: "unipile-linkedin",
    name: "Unipile — LinkedIn",
    description:
      "LinkedIn outreach via Unipile (API-key connector). Stores the Unipile API key in the vault, registers one HTTP API tool that authenticates with Unipile's X-API-KEY header against the account's DSN, and seeds two proposal-gated code skills: search LinkedIn profiles (proposed as `person` entities) and send a connection invitation (the result noted as a `note`). Grounded in synap-backend's UnipileConnector (X-API-KEY auth, /api/v1 base) and the Unipile v1 LinkedIn API. PRECONDITION: a Unipile account with a connected LinkedIn account; pass that account_id as the skill `accountId` arg. The applier remaps the tool credentialRef to a runtime vault://<id>; the skills call the tool by NAME via callProvider('unipile_linkedin', ...), so the dispatcher resolves the credentialRef and injects the vaulted X-API-KEY server-side — no providerRef arg needed.",
    params: [
      {
        name: "unipileApiKey",
        label: "Unipile API key",
        type: "text",
        required: true,
        description:
          "The Unipile X-API-KEY. Stored server-encrypted in the vault; never persisted in the template.",
      },
      {
        name: "unipileBaseUrl",
        label: "Unipile DSN base URL",
        type: "text",
        required: true,
        description:
          "Your Unipile DSN with the /api/v1 prefix, e.g. https://api6.unipile.com:13670/api/v1 — the same DSN UnipileConnector uses. Includes the host and port assigned to your Unipile account.",
      },
      {
        name: "unipileAccountId",
        label: "Unipile LinkedIn account id",
        type: "text",
        required: true,
        description:
          "The Unipile account_id of the connected LinkedIn account that performs the search and sends invitations (from GET /api/v1/accounts). Used as the default skill accountId.",
      },
      {
        name: "entityProfile",
        label: "Target person profile",
        type: "text",
        required: false,
        default: "person",
        description: "The profileSlug found LinkedIn profiles are proposed as.",
      },
    ],
    vault: [
      {
        ref: "unipileApiKeySecret",
        name: "{{name}} Unipile API key",
        value: "{{unipileApiKey}}",
        type: "api_key",
        description: "Unipile X-API-KEY for the LinkedIn connector.",
      },
    ],
    tools: [
      {
        name: "unipile_linkedin",
        kind: "api",
        description:
          "Authenticated HTTP access to the Unipile v1 API (LinkedIn). The applier injects the vaulted API key into the X-API-KEY header; its credentialRef is remapped to the runtime vault://<id> at apply time.",
        credentialRef: "unipileApiKeySecret",
        executor: "is-agent",
        config: {
          baseUrl: "{{unipileBaseUrl}}",
          auth: { in: "header", name: "X-API-KEY", prefix: "" },
        },
      },
    ],
    skills: [
      {
        name: "linkedin_search_profile",
        kind: "code",
        scope: "pod",
        description:
          "Searches LinkedIn profiles via Unipile and proposes each match as a person entity (proposal-gated). Args: { keywords: string, accountId?: string, limit?: number }. Calls the tool by name via callProvider('unipile_linkedin', ...).",
        requires: ["unipile_linkedin"],
        executionMode: "async",
        timeoutSeconds: 60,
        parameters: {
          keywords: "string",
          accountId: "string?",
          limit: "number?",
        },
        code: "// LinkedIn people search via Unipile, proposed as person entities.\n// Executor wraps this body as (async function(args, context){ <code> }); use args\n// directly and `return` the result. callProvider(provider, method, path, body?)\n// runs the required tool through the dispatcher — pass the tool NAME\n// ('unipile_linkedin') and the dispatcher resolves its credentialRef, injects the\n// vaulted X-API-KEY, and uses the tool's config.baseUrl = DSN + /api/v1. No\n// providerRef arg needed.\nconst accountId = String(args?.accountId ?? '{{unipileAccountId}}');\nconst keywords = String(args?.keywords ?? '').trim();\nconst limit = Number(args?.limit ?? 10);\nif (!keywords) throw new Error('linkedin_search_profile: keywords is required');\n\n// Unipile v1 LinkedIn search (category people).\nconst qs = new URLSearchParams({ account_id: accountId, keywords, limit: String(limit) });\nconst res = await callProvider('unipile_linkedin', 'GET', `/linkedin/search?${qs.toString()}`);\nconst payload = res?.body ?? res;\nconst items = Array.isArray(payload?.items) ? payload.items : (Array.isArray(payload) ? payload : []);\n\nconst profileSlug = '{{entityProfile}}' || 'person';\nlet proposed = 0;\nfor (const p of items.slice(0, limit)) {\n  const name = String(p?.name ?? [p?.first_name, p?.last_name].filter(Boolean).join(' ') ?? 'LinkedIn profile').trim() || 'LinkedIn profile';\n  await propose.entity({\n    profileSlug,\n    title: name,\n    properties: {\n      headline: p?.headline ?? null,\n      company: p?.current_company ?? p?.company ?? null,\n      location: p?.location ?? null,\n      linkedinProviderId: p?.provider_id ?? p?.id ?? null,\n      publicIdentifier: p?.public_identifier ?? p?.public_id ?? null,\n      profileUrl: p?.profile_url ?? null,\n      source: 'unipile-linkedin'\n    },\n    reasoning: `LinkedIn profile matched search \"${keywords}\" via Unipile.`\n  });\n  proposed += 1;\n}\nreturn { proposed, keywords };\n",
      },
      {
        name: "linkedin_send_invite",
        kind: "code",
        scope: "pod",
        description:
          "Sends a LinkedIn connection invitation via Unipile, then notes the action as a note entity (proposal-gated). Args: { providerId: string (target LinkedIn provider_id), accountId?: string, message?: string }. Calls the tool by name via callProvider('unipile_linkedin', ...).",
        requires: ["unipile_linkedin"],
        executionMode: "async",
        timeoutSeconds: 60,
        parameters: {
          providerId: "string",
          accountId: "string?",
          message: "string?",
        },
        code: "// Send a LinkedIn connection request via Unipile, then record a note.\n// Executor wraps this body as (async function(args, context){ <code> }); use args\n// directly and `return`. callProvider runs the unipile_linkedin tool through the\n// dispatcher by NAME — the dispatcher resolves its credentialRef and injects the\n// X-API-KEY server-side from the vault; propose.entity routes the write through\n// governance. No providerRef arg needed.\nconst accountId = String(args?.accountId ?? '{{unipileAccountId}}');\nconst providerId = String(args?.providerId ?? '').trim();\nconst message = typeof args?.message === 'string' ? args.message : undefined;\nif (!providerId) throw new Error('linkedin_send_invite: providerId (the target LinkedIn provider_id) is required');\n\n// Unipile v1 connection-request endpoint.\nconst body = { account_id: accountId, provider_id: providerId };\nif (message) body.message = message;\nconst res = await callProvider('unipile_linkedin', 'POST', '/users/invite', body);\nconst ok = res?.status ? res.status >= 200 && res.status < 300 : true;\n\nawait propose.entity({\n  profileSlug: 'note',\n  title: `LinkedIn invitation ${ok ? 'sent' : 'attempted'} -> ${providerId}`,\n  properties: {\n    action: 'linkedin_send_invite',\n    providerId,\n    message: message ?? null,\n    status: res?.status ?? null,\n    success: ok,\n    source: 'unipile-linkedin'\n  },\n  reasoning: 'Recorded the outbound LinkedIn connection request for the activity timeline.'\n});\nreturn { success: ok, providerId, status: res?.status ?? null };\n",
      },
    ],
  },
} as const;

export const BUNDLED_TEMPLATES = RAW as unknown as Record<
  string,
  CapabilityDefinition
>;

export const BUNDLED_TEMPLATE_KEYS: string[] = Object.keys(RAW);

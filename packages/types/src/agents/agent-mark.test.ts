import { describe, expect, it } from 'vitest';
import {
  AGENT_STALE_AFTER_DAYS,
  agentMarkText,
  humanizeAgentHost,
  resolveAgentMark,
  type AgentMarkRowLike,
} from './index';

const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const MIN = 60_000;
const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const row = (over: Partial<AgentMarkRowLike>): AgentMarkRowLike => ({
  id: 'a',
  name: 'Claude Code',
  lastSeenAt: null,
  activeKeys: 0,
  pendingKeys: 0,
  revokedKeys: 0,
  ...over,
});

/**
 * The rows where the two surfaces' OLD rules disagreed (browser
 * `agent-roster-model.ts` vs relay `agents-model.ts`, before this rule). Each
 * row names both old answers, so a row that stops discriminating is visible.
 */
const DISAGREEMENTS: Array<{
  name: string;
  input: AgentMarkRowLike;
  was: { desktop: string; phone: string };
  kind: string;
  tone: string;
}> = [
  {
    name: 'seen before, no live key, no revoked-key evidence',
    input: row({ lastSeenAt: iso(3 * MIN) }),
    was: { desktop: 'Disconnected · seen 3m', phone: 'green Seen 3m ago' },
    kind: 'seen',
    tone: 'success',
  },
  {
    name: 'seen before, key since revoked',
    input: row({ lastSeenAt: iso(3 * MIN), revokedKeys: 1 }),
    was: { desktop: 'Disconnected · seen 3m', phone: 'green Seen 3m ago' },
    kind: 'disconnected',
    tone: 'danger',
  },
  {
    name: 'pending key only, never seen',
    input: row({ pendingKeys: 1 }),
    was: { desktop: 'Key awaits your approval', phone: 'Key awaiting your approval' },
    kind: 'approve',
    tone: 'warning',
  },
  {
    name: 'pending key only, seen before',
    input: row({ pendingKeys: 1, lastSeenAt: iso(3 * MIN) }),
    was: { desktop: 'Disconnected · seen 3m', phone: 'Key awaiting your approval' },
    kind: 'approve',
    tone: 'warning',
  },
  {
    name: 'never seen, no key ever',
    input: row({}),
    was: { desktop: 'Disconnected', phone: 'Waiting for first call' },
    kind: 'noKey',
    tone: 'neutral',
  },
  {
    name: 'never seen, a live key',
    input: row({ activeKeys: 1 }),
    was: { desktop: 'amber Waiting for first call', phone: 'grey Waiting for first call' },
    kind: 'waiting',
    tone: 'neutral',
  },
  {
    name: 'seen long ago with a live key',
    input: row({ activeKeys: 1, lastSeenAt: iso((AGENT_STALE_AFTER_DAYS + 1) * DAY) }),
    was: { desktop: 'green Seen 1w', phone: 'green Seen 1 week ago' },
    kind: 'stale',
    tone: 'neutral',
  },
  {
    name: 'built-in agent',
    input: row({ builtIn: true, lastSeenAt: null }),
    was: { desktop: 'Built-in', phone: '(dropped from the list)' },
    kind: 'builtIn',
    tone: 'neutral',
  },
];

describe('resolveAgentMark — the rows the two surfaces disagreed on', () => {
  for (const c of DISAGREEMENTS) {
    it(`${c.name} (was desktop "${c.was.desktop}" / phone "${c.was.phone}")`, () => {
      const mark = resolveAgentMark(c.input, NOW);
      expect({ kind: mark.kind, tone: mark.tone }).toEqual({ kind: c.kind, tone: c.tone });
    });
  }
});

describe('resolveAgentMark', () => {
  it('no row, or a pod that serves no lastSeenAt ⇒ no mark at all', () => {
    expect(resolveAgentMark(null, NOW)).toMatchObject({ kind: 'unmeasured', label: null });
    const older = { id: 'a', name: 'Codex', activeKeys: 1 } as AgentMarkRowLike;
    expect(resolveAgentMark(older, NOW)).toMatchObject({ kind: 'unmeasured', label: null });
  });

  it('Disconnected needs evidence: an absent revokedKeys (older pod) never claims it', () => {
    const noField = { id: 'a', name: 'Codex', lastSeenAt: null, activeKeys: 0, pendingKeys: 0 };
    expect(resolveAgentMark(noField, NOW).kind).toBe('noKey');
  });

  it('the stale boundary is AGENT_STALE_AFTER_DAYS exactly', () => {
    const edge = AGENT_STALE_AFTER_DAYS * DAY;
    expect(resolveAgentMark(row({ activeKeys: 1, lastSeenAt: iso(edge) }), NOW).kind).toBe('seen');
    expect(resolveAgentMark(row({ activeKeys: 1, lastSeenAt: iso(edge + MIN) }), NOW).kind).toBe(
      'stale',
    );
  });

  it('canDisconnect only when a live or pending key exists, never for built-in', () => {
    expect(resolveAgentMark(row({ activeKeys: 1 }), NOW).canDisconnect).toBe(true);
    expect(resolveAgentMark(row({ pendingKeys: 1 }), NOW).canDisconnect).toBe(true);
    expect(resolveAgentMark(row({ revokedKeys: 2 }), NOW).canDisconnect).toBe(false);
    expect(resolveAgentMark(row({ builtIn: true, activeKeys: 1 }), NOW).canDisconnect).toBe(false);
  });

  it('carries the humanised host, never the raw instance id', () => {
    const mark = resolveAgentMark(
      row({
        activeKeys: 1,
        lastSeenAt: iso(MIN),
        host: 'mcp:9c197945-1b2c-4d5e-8f90-123456789abc:808939d1-86b3-4c52-a153-ae06ece2c54e',
      }),
      NOW,
    );
    expect(mark.host).toBeNull();
  });
});

describe('agentMarkText', () => {
  const rel = () => '3m ago';
  it('seen / stale ⇒ "Seen <time>"', () => {
    expect(agentMarkText(resolveAgentMark(row({ activeKeys: 1, lastSeenAt: iso(3 * MIN) }), NOW), rel)).toBe(
      'Seen 3m ago',
    );
  });
  it('another mark with a last call ⇒ "<label> · seen <time>"', () => {
    expect(
      agentMarkText(resolveAgentMark(row({ revokedKeys: 1, lastSeenAt: iso(3 * MIN) }), NOW), rel),
    ).toBe('Disconnected · seen 3m ago');
  });
  it('no call ⇒ the label; no mark ⇒ null', () => {
    expect(agentMarkText(resolveAgentMark(row({ activeKeys: 1 }), NOW), rel)).toBe('Waiting for first call');
    expect(agentMarkText(resolveAgentMark(null, NOW), rel)).toBeNull();
  });
});

describe('humanizeAgentHost', () => {
  it.each([
    ['mcp:9c197945-1b2c-4d5e-8f90-123456789abc:808939d1-86b3-4c52-a153-ae06ece2c54e', null],
    ['oauth:claude-ai:9c197945-1b2c-4d5e-8f90-123456789abc', 'claude-ai'],
    ['Antoines-MacBook-Pro.local', 'Antoines-MacBook-Pro'],
    ['laptop', 'laptop'],
    ['cli:9c197945abcdef01', null],
    ['', null],
    [null, null],
  ])('%s → %s', (raw, expected) => {
    expect(humanizeAgentHost(raw)).toBe(expected);
  });
});

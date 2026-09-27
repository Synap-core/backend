import { describe, expect, it } from 'vitest';
import { resolveAgentConnection } from './index';

describe('resolveAgentConnection', () => {
  it('reads never when no row carries a last-seen time', () => {
    expect(resolveAgentConnection([])).toEqual({ kind: 'never' });
    expect(
      resolveAgentConnection([
        { id: 'a', name: 'Claude Code', lastSeenAt: null },
        { id: 'b', name: 'Codex' },
      ]),
    ).toEqual({ kind: 'never' });
  });

  it('picks the most recently seen agent, whatever the row order', () => {
    const rows = [
      { id: 'old', name: 'Codex', lastSeenAt: '2026-09-27T10:00:00.000Z' },
      { id: 'new', name: 'Claude Code', lastSeenAt: new Date('2026-09-28T09:00:00.000Z') },
      { id: 'never', name: 'Cursor', lastSeenAt: null },
    ];
    const result = resolveAgentConnection(rows);
    expect(result).toEqual({
      kind: 'seen',
      agent: { id: 'new', name: 'Claude Code', lastSeenAt: new Date('2026-09-28T09:00:00.000Z') },
      others: 1,
    });
    expect(resolveAgentConnection([...rows].reverse())).toEqual(result);
  });

  it('treats an unparseable timestamp as not seen', () => {
    expect(
      resolveAgentConnection([{ id: 'x', name: 'Claude Code', lastSeenAt: 'not a date' }]),
    ).toEqual({ kind: 'never' });
  });
});

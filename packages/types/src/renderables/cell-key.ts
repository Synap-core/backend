/**
 * A cell key's own name, without its namespace: `cell:pkg:deal-board` →
 * `deal-board`, `generated:weekly-pulse` → `weekly-pulse`, `entity-list` →
 * `entity-list`. The ONE rule both the embed model (`describeEmbed`) and the
 * words (`resolveEmbedWords`, `resolveCellInstanceWords`) name a key by. A
 * leaf: it imports nothing.
 */
export function cellKeyName(cellKey: string): string | null {
  return cellKey.split(":").filter(Boolean).pop() ?? null;
}

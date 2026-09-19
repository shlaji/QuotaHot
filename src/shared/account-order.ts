export type AccountOrder = Record<string, string[]>;

export function mergeAccountOrder<T extends { id: string }>(items: T[], savedIds: string[]): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const ordered: T[] = [];
  const seen = new Set<string>();
  for (const id of savedIds) {
    const item = byId.get(id);
    if (item && !seen.has(id)) {
      ordered.push(item);
      seen.add(id);
    }
  }
  for (const item of items) {
    if (!seen.has(item.id)) ordered.push(item);
  }
  return ordered;
}

export function moveAccountId(ids: string[], id: string, targetIndex: number): string[] {
  if (!ids.includes(id)) return [...ids];
  const remaining = ids.filter((candidate) => candidate !== id);
  const boundedIndex = Math.min(remaining.length, Math.max(0, targetIndex));
  remaining.splice(boundedIndex, 0, id);
  return remaining;
}

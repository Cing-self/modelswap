const GROUP_COLLATOR = new Intl.Collator('zh-CN', {
  numeric: true,
  sensitivity: 'base',
});

/** Keep vault group ordering consistent across filters and picker dialogs. */
export function compareGroupNames(a: string, b: string, ungroupedLabel = '') {
  const aUngrouped = a === '' || a === ungroupedLabel;
  const bUngrouped = b === '' || b === ungroupedLabel;
  if (aUngrouped && !bUngrouped) return 1;
  if (!aUngrouped && bUngrouped) return -1;
  return GROUP_COLLATOR.compare(a, b);
}

export function sortGroupEntries<T>(entries: Array<[string, T]>, ungroupedLabel = '') {
  return [...entries].sort(([a], [b]) => compareGroupNames(a, b, ungroupedLabel));
}

/** Filter group picker entries without changing their canonical order. */
export function filterGroupEntries<T>(entries: Array<[string, T]>, query = '') {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...entries];
  return entries.filter(([group]) => group.toLocaleLowerCase().includes(normalized));
}

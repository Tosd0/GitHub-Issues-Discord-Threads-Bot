export function areTagSetsEqual(a: readonly string[], b: readonly string[]) {
  if (a.length !== b.length) return false;

  const aSet = new Set(a);
  return b.every((tagId) => aSet.has(tagId));
}

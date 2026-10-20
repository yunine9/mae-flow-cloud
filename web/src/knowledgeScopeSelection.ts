const contains = (parent: string, path: string) => path === parent || path.startsWith(`${parent}/`);

/** 排除项按目录边界匹配；docs/a 不影响 docs/ab。 */
export function canonicalKnowledgeExclusions(paths: string[]): string[] {
  const unique = [...new Set(paths)].sort();
  return unique.filter(path => !unique.some(parent => parent !== path && contains(parent, path)));
}

export function knowledgeScopeRows(directories: string[], excludedPaths: string[], savedExclusions: string[] = []) {
  const known = new Set(directories);
  return [...new Set([...directories, ...excludedPaths, ...savedExclusions])].sort().map(path => ({
    path, missing: !known.has(path),
    excluded: excludedPaths.some(parent => contains(parent, path)),
    inherited: excludedPaths.some(parent => parent !== path && contains(parent, path)),
    partial: !excludedPaths.some(parent => contains(parent, path))
      && excludedPaths.some(child => child !== path && contains(path, child)),
  }));
}

export function selectKnowledgeDirectory(excludedPaths: string[], path: string, included: boolean): string[] {
  // 排除父目录后子目录不可单独勾选；先恢复父目录，避免显示与保存结果相反。
  if (excludedPaths.some(parent => parent !== path && contains(parent, path))) return excludedPaths;
  const retained = excludedPaths.filter(child => !contains(path, child));
  return canonicalKnowledgeExclusions(included ? retained : [...retained, path]);
}

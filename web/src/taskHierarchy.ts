/**
 * 在调用方已经排好优先级/时间的列表上恢复任务树顺序。
 *
 * 排序只决定各个根任务组、以及同一父任务下兄弟任务的先后；子任务绝不
 * 能被另一个根任务插到主任务之外。没有出现在当前筛选结果中的父任务不
 * 会被凭空补回，孤立子任务仍按原顺序展示，并由卡片说明其主任务来源。
 */
export function orderHierarchyBy<T>(
  items: T[],
  idOf: (item: T) => string,
  parentIdOf: (item: T) => string | undefined,
): T[] {
  const ids = new Set(items.map(idOf));
  const children = new Map<string, T[]>();
  for (const item of items) {
    const parentId = parentIdOf(item);
    if (!parentId || !ids.has(parentId)) continue;
    children.set(parentId, [...(children.get(parentId) ?? []), item]);
  }

  const ordered: T[] = [];
  const visited = new Set<string>();
  const append = (item: T) => {
    const id = idOf(item);
    if (visited.has(id)) return;
    visited.add(id);
    ordered.push(item);
    for (const child of children.get(id) ?? []) append(child);
  };

  for (const item of items) {
    const parentId = parentIdOf(item);
    if (!parentId || !ids.has(parentId)) append(item);
  }
  // 数据异常成环时也不能让任务从列表消失。
  for (const item of items) append(item);
  return ordered;
}

export function orderTaskHierarchy<T extends {
  id: string;
  parent_task_id?: string;
}>(tasks: T[]): T[] {
  return orderHierarchyBy(tasks, (task) => task.id,
    (task) => task.parent_task_id);
}

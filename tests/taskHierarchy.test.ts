import assert from "node:assert/strict";
import test from "node:test";
import { orderHierarchyBy, orderTaskHierarchy } from "../web/src/taskHierarchy";

test("按时间排序后主任务仍带着全部子任务，不被其他任务插开", () => {
  const newestFirst = [
    { id: "child-new", parent_task_id: "parent", created_at: 50 },
    { id: "other", created_at: 40 },
    { id: "child-old", parent_task_id: "parent", created_at: 30 },
    { id: "parent", created_at: 20 },
  ];

  assert.deepEqual(orderTaskHierarchy(newestFirst).map((item) => item.id), [
    "other", "parent", "child-new", "child-old",
  ]);
});

test("团队列表的包装对象也按任务层级成组，问题项保留原有排序位置", () => {
  const newestFirst = [
    { key: "child", task: { id: "child", parent_task_id: "parent" } },
    { key: "issue" },
    { key: "parent", task: { id: "parent" } },
  ];

  const ordered = orderHierarchyBy(newestFirst,
    (item) => item.task?.id ?? item.key,
    (item) => item.task?.parent_task_id);
  assert.deepEqual(ordered.map((item) => item.key), [
    "issue", "parent", "child",
  ]);
});

test("父任务被筛掉时子任务不会消失", () => {
  const filtered = [{ id: "child", parent_task_id: "hidden-parent" }];
  assert.deepEqual(orderTaskHierarchy(filtered), filtered);
});

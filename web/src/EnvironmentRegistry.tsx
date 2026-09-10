/**
 * 环境管理(ADR-0020;票 #149 前端半边):全局网管环境台账的页签。
 *
 * Tailwind/shadcn 第一页,#146 触碰即迁约束的第一个适用对象:样式全走
 * 工具类 + components/ui 的 shadcn 组件皮,根元素挂 .tw-root 做 scoped
 * 归一(tailwind.css fixes 层),不往 legacy css 层加任何东西、不 import
 * 任何 css 文件(组件要能被 node 契约测试直接读源码断言)。
 *
 * 密码纪律(ADR-0020):表单永不回显密码——编辑时后台密码只显示"已配置"
 * 占位,留空 = 不变;root 密码留空 = 继承后台密码,已单独配置的条目可一键
 * 清除回落继承。台账全员可读写,写操作 updated_by 由服务端记。
 */
import { useEffect, useMemo, useState } from "react";
import {
  deleteEnvironment,
  listEnvironments,
  probeEnvironment,
  type EnvironmentView,
} from "./api";
import { PersonName } from "./People";
import { confirmDialog } from "./ConfirmDialog";
import { formatLocalDateTime, relativeTime } from "./time";
import {
  ENVIRONMENT_FORM_TEXT,
  EnvironmentEditorDialog,
  PROBE_REASON_TEXT,
} from "./EnvironmentEditorDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** 探活三态文案(本票只有未验证一态,#151 探活点亮其余)。 */
const PROBE_TEXT: Record<EnvironmentView["probe"]["state"], string> = {
  unverified: "未验证",
  ok: "正常",
  failed: "异常",
};

/** 探活失败原因二分(#151)的文案与色语义码表随共用弹框模块走
 * (EnvironmentEditorDialog),页面只消费展示。 */

/** 状态列徽标的色语义(#151):正常绿系、异常红系、未验证中性灰——
 * 全走 tailwind.css @theme 桥映射出的令牌工具类(--color-success/--color-danger
 * 系),不硬编码色值。 */
function probeToneClass(state: EnvironmentView["probe"]["state"]): string {
  if (state === "ok") return "border-success/40 bg-success-soft text-success";
  if (state === "failed") return "border-danger/40 bg-danger-soft text-danger";
  return "text-muted-foreground";
}

/** 状态列单元格(#151):三态徽标,异常条目附原因二分,探过的条目附
 * 最近探活时间(相对时间,悬浮看绝对时刻)。 */
function ProbeStateCell({ probe }: { probe: EnvironmentView["probe"] }) {
  return <div className="flex flex-col items-start gap-0.5">
    <Badge variant="outline" className={probeToneClass(probe.state)}>
      {PROBE_TEXT[probe.state] ?? "未验证"}
    </Badge>
    {probe.state === "failed" && probe.reason && (
      <span className="text-xs text-danger">
        {PROBE_REASON_TEXT[probe.reason] ?? probe.reason}
      </span>
    )}
    {probe.at && <span className="text-xs text-muted-foreground"
      title={`探活于 ${formatLocalDateTime(probe.at)}`}>
      {relativeTime(probe.at)}探活
    </span>}
  </div>;
}

/** Radix Select 不收空串 value,"全部标签"用哨兵值。 */
const ALL_TAGS = "__all";

export function EnvironmentRegistry() {
  const [environments, setEnvironments] = useState<EnvironmentView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  /** 标签筛选:点行内标签徽标或下拉都汇入这一个状态(空串 = 不筛)。 */
  const [activeTag, setActiveTag] = useState("");
  /** 弹层状态:undefined = 关;existing 缺席 = 新增,有值 = 编辑该条。 */
  const [editor, setEditor] = useState<{ existing?: EnvironmentView }>();
  /** 行内探活进行中的条目 id(空串 = 空闲;一次探一条)。 */
  const [probingId, setProbingId] = useState("");

  /** 探活返回更新后的视图:就地合并进列表,状态列即时刷新(不整页轮询,
   * 后台已有约 10 分钟一轮的定时探活)。 */
  function applyProbeUpdate(updated: EnvironmentView) {
    setEnvironments((prev) =>
      prev.map((item) => (item.id === updated.id ? updated : item)));
  }

  /** 行内探活(#151):对已存条目用台账后台密码探一次并持久化三态。 */
  async function probeRow(entry: EnvironmentView) {
    if (probingId) return;
    setProbingId(entry.id);
    try {
      applyProbeUpdate(await probeEnvironment(entry.id));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "环境探活失败");
    } finally {
      setProbingId("");
    }
  }

  async function refreshEnvironments() {
    try {
      setEnvironments(await listEnvironments());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "环境列表加载失败");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refreshEnvironments(); }, []);

  const allTags = useMemo(() =>
    [...new Set(environments.flatMap((entry) => entry.tags))].sort(),
    [environments]);
  const visible = useMemo(() => activeTag
    ? environments.filter((entry) => entry.tags.includes(activeTag))
    : environments, [environments, activeTag]);

  /** 删除走全站既有 confirmDialog 二次确认(spec #52),不用裸 window.confirm;
   * 台账删除不影响已选入会话的快照(ADR-0020),确认卡里说破。 */
  async function removeEnvironment(entry: EnvironmentView) {
    if (!await confirmDialog({
      title: `删除环境 ${entry.ip}`,
      message: <>这台环境将从环境管理里移除;正在进行的问题不受影响
        (密码在开始处理时已单独留存)。</>,
      confirmLabel: "删除",
      danger: true,
    })) return;
    try {
      await deleteEnvironment(entry.id);
      await refreshEnvironments();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "环境删除失败");
    }
  }

  return <section
    className="tw-root flex flex-col gap-4 text-base text-foreground"
    aria-label="环境管理台账"
  >
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={activeTag || ALL_TAGS}
        onValueChange={(next) => setActiveTag(next === ALL_TAGS ? "" : next)}
      >
        <SelectTrigger size="sm" className="w-44" aria-label="按标签筛选">
          <SelectValue placeholder="按标签筛选" />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value={ALL_TAGS}>全部标签</SelectItem>
          {allTags.map((tag) => <SelectItem key={tag} value={tag}>{tag}</SelectItem>)}
        </SelectContent>
      </Select>
      {activeTag && <Button variant="ghost" size="sm"
        onClick={() => setActiveTag("")}>清除筛选</Button>}
      <div className="grow" />
      <Button variant="outline" size="sm"
        onClick={() => void refreshEnvironments()}>刷新</Button>
      <Button size="sm" onClick={() => setEditor({})}>新增环境</Button>
    </div>

    {error && <div role="alert"
      className="rounded-md border border-destructive/40 bg-danger-soft px-3 py-2 text-sm text-danger">
      {error}
    </div>}

    {loading ? <p className="text-sm text-muted-foreground">环境台账加载中…</p>
      : environments.length === 0
        ? <div
            data-testid="environment-registry-empty"
            className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line px-6 py-12 text-center">
          <p className="text-base font-medium">还没有环境</p>
          <p className="max-w-md text-sm text-muted-foreground">
            点「新增环境」录入第一台网管环境(主 IP、形态、端口、后台密码),
            之后登记问题、处理问题需要环境时直接选,不用重复手填。
          </p>
          <Button size="sm" onClick={() => setEditor({})}>新增环境</Button>
        </div>
        : <div className="overflow-x-auto rounded-lg border border-line">
          <Table aria-label="环境台账列表">
            <TableHeader>
              <TableRow>
                <TableHead>主 IP</TableHead>
                <TableHead>形态</TableHead>
                <TableHead>端口</TableHead>
                <TableHead>标签</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>更新人</TableHead>
                <TableHead>更新时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((entry) => <TableRow key={entry.id}
                data-environment-id={entry.id}>
                <TableCell className="font-medium">{entry.ip}</TableCell>
                <TableCell>{ENVIRONMENT_FORM_TEXT[entry.form] ?? entry.form}</TableCell>
                <TableCell>{entry.port}</TableCell>
                <TableCell>
                  {entry.tags.length
                    ? <div className="flex flex-wrap gap-1">
                      {entry.tags.map((tag) => <Badge
                        key={tag}
                        asChild
                        variant={tag === activeTag ? "default" : "secondary"}>
                        <button type="button" className="cursor-pointer"
                          title={`筛选标签 ${tag}`}
                          aria-pressed={tag === activeTag}
                          onClick={() => setActiveTag(tag === activeTag ? "" : tag)}>
                          {tag}
                        </button>
                      </Badge>)}
                    </div>
                    : <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell>
                  <ProbeStateCell probe={entry.probe} />
                </TableCell>
                <TableCell><PersonName account={entry.updated_by} /></TableCell>
                <TableCell>{formatLocalDateTime(entry.updated_at)}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="xs"
                      disabled={probingId === entry.id}
                      onClick={() => void probeRow(entry)}>
                      {probingId === entry.id ? "探活中…" : "探活"}
                    </Button>
                    <Button variant="ghost" size="xs"
                      onClick={() => setEditor({ existing: entry })}>编辑</Button>
                    <Button variant="ghost" size="xs"
                      className="text-destructive hover:text-destructive"
                      onClick={() => void removeEnvironment(entry)}>删除</Button>
                  </div>
                </TableCell>
              </TableRow>)}
              {visible.length === 0 && <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                  没有打了标签「{activeTag}」的环境。
                  <button type="button"
                    className="ml-1 text-ink underline underline-offset-4"
                    onClick={() => setActiveTag("")}>清除筛选</button>
                </TableCell>
              </TableRow>}
            </TableBody>
          </Table>
        </div>}

    {editor && <EnvironmentEditorDialog
      key={editor.existing?.id ?? "create"}
      existing={editor.existing}
      environments={environments}
      onClose={() => setEditor(undefined)}
      onSaved={() => {
        setEditor(undefined);
        void refreshEnvironments();
      }}
      onProbed={applyProbeUpdate}
      onSwitchTo={(entry) => setEditor({ existing: entry })}
    />}
  </section>;
}

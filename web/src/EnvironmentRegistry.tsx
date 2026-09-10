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
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
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
/** Radix Select 同理,"全部状态"用哨兵值。 */
const ALL_STATES = "__all_states";

/** 可排序列(标签是多值不排,操作列非数据)。 */
type SortKey = "ip" | "form" | "port" | "state" | "updated_by" | "updated_at";

/** 状态排序档:升序=异常最前、正常最后——最需要处理的排最上。 */
const STATE_RANK: Record<EnvironmentView["probe"]["state"], number> = {
  failed: 0,
  unverified: 1,
  ok: 2,
};

/** IP 比较:双方都是 IPv4 时按数值逐段比(字典序会让 10.0.0.9 排到
 * 10.0.0.10 之后),IPv6/其他形态退回字典序。 */
function compareIp(a: string, b: string): number {
  const octets = (ip: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)
    ? ip.split(".").map(Number)
    : null;
  const av = octets(a);
  const bv = octets(b);
  if (av && bv) {
    for (let i = 0; i < 4; i += 1) {
      if (av[i] !== bv[i]) return av[i] - bv[i];
    }
    return 0;
  }
  return a.localeCompare(b);
}

/** 表头排序标记:未排序给双箭头提示可点,激活后给方向单箭头。 */
function SortMark({ active, dir }: { active: boolean; dir?: 1 | -1 }) {
  if (!active) {
    return <ChevronsUpDown aria-hidden className="size-3 text-muted-foreground" />;
  }
  return dir === 1
    ? <ArrowUp aria-hidden className="size-3" />
    : <ArrowDown aria-hidden className="size-3" />;
}

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
  /** 列排序:点表头 升→降→取消 三态循环;null = 保持登记顺序。 */
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  /** 搜索:IP/标签/形态/更新人 子串,大小写不敏感,与下拉筛选叠乘。 */
  const [search, setSearch] = useState("");
  /** 状态筛选(空串 = 全部):探活三态,异常条目一眼可捞。 */
  const [stateFilter, setStateFilter] = useState("");

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

  function toggleSort(key: SortKey) {
    setSort((cur) => cur?.key === key
      ? (cur.dir === 1 ? { key, dir: -1 } : null)
      : { key, dir: 1 });
  }

  const query = search.trim().toLowerCase();
  const visible = useMemo(() => {
    const filtered = environments.filter((entry) => {
      if (activeTag && !entry.tags.includes(activeTag)) return false;
      if (stateFilter && entry.probe.state !== stateFilter) return false;
      if (!query) return true;
      return entry.ip.toLowerCase().includes(query)
        || entry.tags.some((tag) => tag.toLowerCase().includes(query))
        || (ENVIRONMENT_FORM_TEXT[entry.form] ?? entry.form).toLowerCase().includes(query)
        || entry.updated_by.toLowerCase().includes(query);
    });
    if (!sort) return filtered;
    const { key, dir } = sort;
    const cmp = (a: EnvironmentView, b: EnvironmentView): number => {
      if (key === "ip") return compareIp(a.ip, b.ip);
      if (key === "port") return a.port - b.port;
      if (key === "state") {
        return STATE_RANK[a.probe.state] - STATE_RANK[b.probe.state];
      }
      if (key === "updated_at") return a.updated_at.localeCompare(b.updated_at);
      if (key === "form") {
        return (ENVIRONMENT_FORM_TEXT[a.form] ?? a.form)
          .localeCompare(ENVIRONMENT_FORM_TEXT[b.form] ?? b.form);
      }
      return a.updated_by.localeCompare(b.updated_by);
    };
    return [...filtered].sort((a, b) => dir * cmp(a, b));
  }, [environments, activeTag, stateFilter, query, sort]);

  /** 表头排序钮的 aria-sort 值(未排序列不给属性)。 */
  function ariaSortOf(key: SortKey) {
    if (sort?.key !== key) return undefined;
    return sort.dir === 1 ? "ascending" : "descending";
  }
  const filtersActive = Boolean(activeTag || stateFilter || search.trim());

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
      <input
        className="h-8 w-52 rounded-md border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        placeholder="搜 IP、标签、形态、更新人…"
        aria-label="搜索环境"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <Select
        value={activeTag || ALL_TAGS}
        onValueChange={(next) => setActiveTag(next === ALL_TAGS ? "" : next)}
      >
        <SelectTrigger size="sm" className="w-40" aria-label="按标签筛选">
          <SelectValue placeholder="按标签筛选" />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value={ALL_TAGS}>全部标签</SelectItem>
          {allTags.map((tag) => <SelectItem key={tag} value={tag}>{tag}</SelectItem>)}
        </SelectContent>
      </Select>
      <Select
        value={stateFilter || ALL_STATES}
        onValueChange={(next) => setStateFilter(next === ALL_STATES ? "" : next)}
      >
        <SelectTrigger size="sm" className="w-32" aria-label="按状态筛选">
          <SelectValue placeholder="按状态筛选" />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value={ALL_STATES}>全部状态</SelectItem>
          <SelectItem value="ok">正常</SelectItem>
          <SelectItem value="failed">异常</SelectItem>
          <SelectItem value="unverified">未验证</SelectItem>
        </SelectContent>
      </Select>
      {filtersActive && <Button variant="ghost" size="sm"
        onClick={() => {
          setActiveTag("");
          setStateFilter("");
          setSearch("");
        }}>清除筛选</Button>}
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
                <TableHead aria-sort={ariaSortOf("ip")}>
                  <button type="button"
                    className="inline-flex items-center gap-1 hover:text-foreground"
                    onClick={() => toggleSort("ip")}>
                    主 IP<SortMark active={sort?.key === "ip"} dir={sort?.dir} />
                  </button>
                </TableHead>
                <TableHead aria-sort={ariaSortOf("form")}>
                  <button type="button"
                    className="inline-flex items-center gap-1 hover:text-foreground"
                    onClick={() => toggleSort("form")}>
                    形态<SortMark active={sort?.key === "form"} dir={sort?.dir} />
                  </button>
                </TableHead>
                <TableHead aria-sort={ariaSortOf("port")}>
                  <button type="button"
                    className="inline-flex items-center gap-1 hover:text-foreground"
                    onClick={() => toggleSort("port")}>
                    端口<SortMark active={sort?.key === "port"} dir={sort?.dir} />
                  </button>
                </TableHead>
                <TableHead>标签</TableHead>
                <TableHead aria-sort={ariaSortOf("state")}>
                  <button type="button"
                    className="inline-flex items-center gap-1 hover:text-foreground"
                    onClick={() => toggleSort("state")}>
                    状态<SortMark active={sort?.key === "state"} dir={sort?.dir} />
                  </button>
                </TableHead>
                <TableHead aria-sort={ariaSortOf("updated_by")}>
                  <button type="button"
                    className="inline-flex items-center gap-1 hover:text-foreground"
                    onClick={() => toggleSort("updated_by")}>
                    更新人<SortMark active={sort?.key === "updated_by"} dir={sort?.dir} />
                  </button>
                </TableHead>
                <TableHead aria-sort={ariaSortOf("updated_at")}>
                  <button type="button"
                    className="inline-flex items-center gap-1 hover:text-foreground"
                    onClick={() => toggleSort("updated_at")}>
                    更新时间<SortMark active={sort?.key === "updated_at"} dir={sort?.dir} />
                  </button>
                </TableHead>
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
                  {activeTag
                    ? <>没有打了标签「{activeTag}」的环境。</>
                    : search.trim()
                      ? <>没有匹配「{search.trim()}」的环境。</>
                      : "没有符合条件的环境。"}
                  <button type="button"
                    className="ml-1 text-ink underline underline-offset-4"
                    onClick={() => {
                      setActiveTag("");
                      setStateFilter("");
                      setSearch("");
                    }}>清除筛选</button>
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

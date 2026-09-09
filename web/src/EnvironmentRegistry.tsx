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
import type { FormEvent, KeyboardEvent } from "react";
import {
  createEnvironment,
  deleteEnvironment,
  listEnvironments,
  probeEnvironment,
  testEnvironmentConnection,
  updateEnvironment,
  EnvironmentIpConflictError,
  type EnvironmentForm,
  type EnvironmentTestOutcome,
  type EnvironmentView,
} from "./api";
import { PersonName } from "./People";
import { confirmDialog } from "./ConfirmDialog";
import { formatLocalDateTime, relativeTime } from "./time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

/** 环境形态的页面文案(CONTEXT.md「环境形态」:虚拟化/容器化二选一)。 */
const FORM_TEXT: Record<EnvironmentForm, string> = {
  virtualized: "虚拟化",
  k8s: "容器化",
};

/** 探活三态文案(本票只有未验证一态,#151 探活点亮其余)。 */
const PROBE_TEXT: Record<EnvironmentView["probe"]["state"], string> = {
  unverified: "未验证",
  ok: "正常",
  failed: "异常",
};

/** 探活失败原因二分(#151):auth=密码改了,unreachable=机器关了。 */
const PROBE_REASON_TEXT: Record<
  NonNullable<EnvironmentView["probe"]["reason"]>,
  string
> = {
  auth: "认证失败",
  unreachable: "不可达",
};

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

const inputClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";
const fieldLabelClass = "text-sm font-medium text-foreground";
const fieldWrapClass = "grid gap-1.5";

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
      setError(cause instanceof Error ? cause.message : "环境台账加载失败");
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
      message: <>条目将从台账移除;已选入会话的环境是选定时的快照,
        不受台账改动与删除影响。</>,
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
            点「新增环境」录入第一个网管环境(主 IP、形态、端口、后台密码),
            之后登记问题与会话里需要环境时直接快选,不必再重复手输。
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
                <TableCell>{FORM_TEXT[entry.form] ?? entry.form}</TableCell>
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

const tagChipRemoveClass =
  "ml-0.5 inline-flex size-4 items-center justify-center rounded-full hover:bg-accent";

/** 新增/编辑弹层。existing 有值 = 编辑:密码字段不回显,后台密码留空 =
 * 不变,root 密码留空 = 不改继承关系。IP 撞车(409)在表单内报错并引导
 * 去编辑既有条目。「测试连接」按钮(#151)两种调用分野:新增态用表单
 * 当前值走 /environments/test(只探测不落库,后台密码必须已填);编辑态
 * 前端无密码,直接对已存条目探活走 /:id/probe(结果持久化进台账)。
 * 结果就地内联展示,不关弹层。 */
function EnvironmentEditorDialog({
  existing,
  environments,
  onClose,
  onSaved,
  onProbed,
  onSwitchTo,
}: {
  existing?: EnvironmentView;
  environments: EnvironmentView[];
  onClose: () => void;
  onSaved: () => void;
  onProbed: (entry: EnvironmentView) => void;
  onSwitchTo: (entry: EnvironmentView) => void;
}) {
  const [ip, setIp] = useState(existing?.ip ?? "");
  const [portDraft, setPortDraft] = useState(String(existing?.port ?? 22));
  const [form, setForm] = useState<EnvironmentForm>(existing?.form ?? "virtualized");
  const [backendPassword, setBackendPassword] = useState("");
  const [rootPassword, setRootPassword] = useState("");
  /** 编辑态点了"清除并回落继承":保存时 root_password 送 null。 */
  const [clearRoot, setClearRoot] = useState(false);
  const [tags, setTags] = useState<string[]>(existing?.tags ?? []);
  const [tagDraft, setTagDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  /** 409 命中的既有条目(表单内报"该 IP 已存在于台账"并引导编辑)。 */
  const [conflict, setConflict] = useState<EnvironmentView>();
  /** 测试连接三态:outcome 空缺 = 空闲;testing = 探测中;有 outcome = 有
   * 结论(就地内联展示,不关弹层)。 */
  const [testing, setTesting] = useState(false);
  const [testOutcome, setTestOutcome] = useState<EnvironmentTestOutcome>();
  const [testError, setTestError] = useState("");
  /** 编辑时若已单独配置 root 密码,给标记与清除入口(非密布尔,可展示)。 */
  const hasExplicitRoot = !!existing && !existing.root_password_inherited;

  function commitTagDraft(event: KeyboardEvent<HTMLInputElement>) {
    // 回车成标签;输入法组词中的回车是选字,不是提交。
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const tag = tagDraft.trim();
    if (!tag) return;
    if (!tags.includes(tag)) setTags([...tags, tag]);
    setTagDraft("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const trimmedIp = ip.trim();
    if (!trimmedIp) {
      setFormError("主 IP 不能为空");
      return;
    }
    const port = portDraft.trim() === "" ? undefined : Number(portDraft);
    if (port !== undefined
        && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      setFormError("端口必须是 1-65535");
      return;
    }
    if (!existing && !backendPassword) {
      setFormError("后台密码不能为空");
      return;
    }
    setBusy(true);
    setFormError("");
    setConflict(undefined);
    try {
      if (existing) {
        await updateEnvironment(existing.id, {
          ip: trimmedIp,
          ...(port !== undefined ? { port } : {}),
          form,
          tags,
          // 密码不回显、留空 = 不变:空串就不进 payload(缺席语义)。
          ...(backendPassword ? { backend_password: backendPassword } : {}),
          // root:清除了显式值送 null 回落继承;填了新值送值;都没动就缺席。
          ...(clearRoot ? { root_password: null }
            : rootPassword ? { root_password: rootPassword } : {}),
        });
      } else {
        await createEnvironment({
          ip: trimmedIp,
          ...(port !== undefined ? { port } : {}),
          form,
          backend_password: backendPassword,
          ...(rootPassword ? { root_password: rootPassword } : {}),
          tags,
        });
      }
      onSaved();
    } catch (cause) {
      if (cause instanceof EnvironmentIpConflictError) {
        setConflict(
          environments.find((entry) => entry.id === cause.existingId));
        setFormError("该 IP 已存在于台账");
      } else {
        setFormError(cause instanceof Error ? cause.message : "保存失败");
      }
    } finally {
      setBusy(false);
    }
  }

  /** 测试连接(#151)的调用分野:新增态用表单当前值走 /environments/test
   * (只探测不落库,后台密码必须已填);编辑态前端无密码,直接对已存条目
   * 探活走 /:id/probe,结论持久化进台账、状态列随 onProbed 就地刷新。
   * 探测失败是结论不是错误:正常/异常+原因都内联展示,弹层不关。 */
  async function runTestConnection() {
    if (testing) return;
    setTestOutcome(undefined);
    setTestError("");
    let port: number | undefined;
    if (!existing) {
      const trimmedIp = ip.trim();
      if (!trimmedIp) {
        setTestError("主 IP 不能为空");
        return;
      }
      port = portDraft.trim() === "" ? undefined : Number(portDraft);
      if (port !== undefined
          && (!Number.isInteger(port) || port < 1 || port > 65535)) {
        setTestError("端口必须是 1-65535");
        return;
      }
      if (!backendPassword) {
        setTestError("后台密码不能为空");
        return;
      }
    }
    setTesting(true);
    try {
      if (existing) {
        const updated = await probeEnvironment(existing.id);
        onProbed(updated);
        setTestOutcome(updated.probe.state === "failed"
          ? { ok: false, reason: updated.probe.reason ?? "unreachable" }
          : { ok: true });
      } else {
        setTestOutcome(await testEnvironmentConnection({
          ip: ip.trim(),
          ...(port !== undefined ? { port } : {}),
          backend_password: backendPassword,
        }));
      }
    } catch (cause) {
      setTestError(cause instanceof Error ? cause.message : "测试连接失败");
    } finally {
      setTesting(false);
    }
  }

  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="tw-root sm:max-w-lg"
      aria-labelledby="environment-editor-title">
      <DialogHeader>
        <DialogTitle id="environment-editor-title">
          {existing ? `编辑环境 ${existing.ip}` : "新增环境"}
        </DialogTitle>
        <DialogDescription>
          {existing
            ? "密码不回显:留空表示不变;root 密码留空表示不改继承关系。"
            : "一条记录一个环境,以主 IP 为唯一键;root 密码留空时与后台密码相同。"}
        </DialogDescription>
      </DialogHeader>
      <form className="grid gap-3" onSubmit={submit}>
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
          <label className={fieldWrapClass}>
            <span className={fieldLabelClass}>主 IP</span>
            <input className={inputClass} value={ip}
              onChange={(event) => setIp(event.target.value)}
              placeholder="例如 10.66.1.12" autoFocus required />
          </label>
          <label className={fieldWrapClass}>
            <span className={fieldLabelClass}>端口</span>
            <input className={inputClass} type="number" min={1} max={65535}
              value={portDraft}
              onChange={(event) => setPortDraft(event.target.value)}
              placeholder="22" />
          </label>
        </div>
        <label className={fieldWrapClass}>
          <span className={fieldLabelClass}>环境形态</span>
          <Select value={form} onValueChange={(next) => setForm(next as EnvironmentForm)}>
            <SelectTrigger className="w-full" aria-label="环境形态">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="virtualized">虚拟化(经网管节点)</SelectItem>
              <SelectItem value="k8s">容器化(经 OM 节点)</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className={fieldWrapClass}>
          <span className={fieldLabelClass}>后台密码</span>
          {/* 永不回显:编辑时只给"已配置"占位,值永远不进 value/URL/列表。 */}
          <input className={inputClass} type="password"
            value={backendPassword}
            onChange={(event) => setBackendPassword(event.target.value)}
            autoComplete="new-password"
            placeholder={existing ? "已配置——留空表示不变" : "sopuser 三账号共用的密码"}
            required={!existing} />
        </label>
        <label className={fieldWrapClass}>
          <span className={fieldLabelClass}>root 密码(可选)</span>
          <input className={inputClass} type="password"
            value={clearRoot ? "" : rootPassword}
            onChange={(event) => {
              setRootPassword(event.target.value);
              setClearRoot(false);
            }}
            autoComplete="new-password"
            placeholder="留空时与后台密码相同"
            disabled={clearRoot} />
        </label>
        {hasExplicitRoot && !clearRoot && <div className="flex items-center gap-2">
          <Badge variant="outline">已单独配置 root 密码</Badge>
          <Button type="button" variant="ghost" size="xs"
            onClick={() => setClearRoot(true)}>清除并回落继承</Button>
        </div>}
        {clearRoot && <p className="text-xs text-muted-foreground">
          保存后 root 密码将回落继承后台密码。
          <button type="button"
            className="ml-1 text-ink underline underline-offset-4"
            onClick={() => setClearRoot(false)}>撤销</button>
        </p>}
        <div className={fieldWrapClass}>
          <span className={fieldLabelClass}>标签</span>
          <input className={inputClass} value={tagDraft}
            onChange={(event) => setTagDraft(event.target.value)}
            onKeyDown={commitTagDraft}
            placeholder="自由输入,回车成标签(如 华为云、v6版本)" />
          {tags.length > 0 && <div className="flex flex-wrap gap-1">
            {tags.map((tag) => <Badge key={tag} variant="secondary">
              {tag}
              <button type="button" className={tagChipRemoveClass}
                aria-label={`移除标签 ${tag}`}
                onClick={() => setTags(tags.filter((item) => item !== tag))}>
                ×
              </button>
            </Badge>)}
          </div>}
        </div>
        {/* 测试连接(#151):结果就地内联展示(正常/异常+原因),不关弹层;
             编辑态走台账已存密码探活,结论顺带持久化进台账。 */}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm"
            disabled={testing}
            onClick={() => void runTestConnection()}>
            {testing ? "探测中…" : "测试连接"}
          </Button>
          {testOutcome?.ok && <Badge variant="outline"
            className={probeToneClass("ok")}>连接正常</Badge>}
          {testOutcome && !testOutcome.ok && <span
            className="text-sm text-danger">
            连接异常:{PROBE_REASON_TEXT[testOutcome.reason] ?? testOutcome.reason}
          </span>}
          {testError && <span className="text-sm text-danger">{testError}</span>}
        </div>
        {(formError || conflict) && <div role="alert"
          className="rounded-md border border-destructive/40 bg-danger-soft px-3 py-2 text-sm text-danger">
          <p>{formError}</p>
          {conflict && <p className="mt-1">
            <button type="button"
              className="text-ink underline underline-offset-4"
              onClick={() => onSwitchTo(conflict)}>编辑既有条目({conflict.ip})</button>
          </p>}
        </div>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>取消</Button>
          <Button type="submit" disabled={busy}>
            {busy ? "保存中…" : existing ? "保存修改" : "录入台账"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

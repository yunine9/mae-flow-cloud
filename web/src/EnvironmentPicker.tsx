/**
 * 环境快选(票 #150,ADR-0020;2026-09-10 走查重铸):从环境管理选一条
 * 网管环境的共用选择器——登记页「网管环境」与 env_needed 闸卡共用。
 *
 * 交互口径(走查裁定):只选不手填。可搜索下拉最适合作「选择」这件事:
 * 触发器显示当前选中(IP 即名字,等宽体),展开是搜索框 + 环境清单,
 * 按 IP/标签/形态模糊过滤,方向键高亮、回车选中、Esc 关闭;搜不到时
 * 「新增环境」弹共用表单(EnvironmentEditorDialog),录入成功后自动
 * 选中新条目——选择和新建是同一条路径的两端,不再并存两套输入面。
 *
 * 零密码契约:列表视图(EnvironmentView)没有任何密码字段,这里展示与
 * 提交的只有非密元信息(IP/形态/标签/端口);选中后只上送条目 id,值由
 * 服务端解密留档进会话(选入即定,之后环境管理里怎么改/删都不影响
 * 已进行的会话)。新 UI 一律 Tailwind(#146):根元素挂 .tw-root 做
 * scoped 归一——注意下拉弹层经 portal 挂到 body,不在根的子树里,
 * PopoverContent 必须自带 .tw-root,否则 UA 默认的 p 边距/button 底色
 * 会在弹层里漏出来(2026-09-10 走查实测)。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Check, ChevronDown, Plus } from "lucide-react";
import { listEnvironments, type EnvironmentView } from "./api";
import {
  ENVIRONMENT_FORM_TEXT,
  EnvironmentEditorDialog,
} from "./EnvironmentEditorDialog";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/** 搜索框与触发器共用的控件皮(shadcn input 同款配方)。 */
const envControlClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm "
  + "shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] "
  + "focus-visible:ring-ring/50";

function formText(entry: EnvironmentView): string {
  return ENVIRONMENT_FORM_TEXT[entry.form] ?? entry.form;
}

/** 模糊匹配:IP / 标签 / 形态文案,大小写不敏感(IP 即名字,主键)。 */
function matches(entry: EnvironmentView, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return entry.ip.toLowerCase().includes(q)
    || entry.tags.some((tag) => tag.toLowerCase().includes(q))
    || formText(entry).toLowerCase().includes(q);
}

export function EnvironmentPicker({ selectedId, onPick }: {
  /** 当前选中的环境条目 id(受控;空 = 未选)。 */
  selectedId?: string | null;
  /** 选中一条环境(上送条目 id,值由服务端留档)。 */
  onPick: (entry: EnvironmentView) => void;
}) {
  const [environments, setEnvironments] = useState<EnvironmentView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** 键盘高亮行(过滤后清单的下标;-1 = 无)。 */
  const [highlighted, setHighlighted] = useState(-1);
  /** 「找不到就新建」弹层:undefined = 关;existing 缺席 = 新增。 */
  const [editor, setEditor] = useState<{ existing?: EnvironmentView }>();

  async function load() {
    setLoading(true);
    try {
      setEnvironments(await listEnvironments());
      setError("");
    } catch (cause) {
      // 加载失败给人话,不把服务端/网络的原始报错(如「未知路径」)
      // 原样上屏;细节进 console 供排查。
      console.error("环境列表加载失败", cause);
      setError("环境列表暂时加载不了,请稍后重试。");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  const filtered = useMemo(
    () => environments.filter((entry) => matches(entry, query)),
    [environments, query]);
  const selected = environments.find((entry) => entry.id === selectedId) ?? null;

  function toggleOpen(next: boolean) {
    setOpen(next);
    if (next) {
      // 每次展开都重拉列表:别处刚登记的环境立刻可见,不需要手动刷新。
      setQuery("");
      setHighlighted(-1);
      void load();
    }
  }

  function pick(entry: EnvironmentView) {
    onPick(entry);
    toggleOpen(false);
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted((current) => {
        const total = filtered.length;
        if (!total) return -1;
        return (current + delta + total) % total;
      });
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setHighlighted(filtered.length ? 0 : -1);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setHighlighted(filtered.length ? filtered.length - 1 : -1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const entry = filtered[highlighted];
      if (entry) pick(entry);
      return;
    }
    // 输入法组词中的按键不当作导航(回车选字不是提交)。
    if (event.nativeEvent.isComposing) event.preventDefault();
  }

  /** 新建保存:合入列表;新建出的条目自动选中(走查裁定的闭环)。 */
  function saved(entry?: EnvironmentView) {
    setEditor(undefined);
    if (!entry) {
      void load();
      return;
    }
    setEnvironments((prev) => [...prev, entry]);
    onPick(entry);
  }

  // 键盘高亮跟随:方向键把高亮推到可视区外时,把那一行滚回清单视口
  // (block:nearest 只滚清单容器本身,不动页面)。纯鼠标用户看不到高亮,
  // 行另有 hover 底色反馈。
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (highlighted < 0) return;
    listRef.current?.querySelector<HTMLElement>('[data-highlighted="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  return <div className="tw-root" aria-label="从环境管理选择">
    <Popover open={open} onOpenChange={toggleOpen}>
      <PopoverTrigger
        render={
          <button type="button"
            className={`${envControlClass} flex items-center justify-between gap-2 text-left`}
            aria-expanded={open}
            aria-label={selected ? `已选环境 ${selected.ip}` : "选择网管环境"}>
            {selected
              ? <span className="flex min-w-0 items-center gap-2">
                <span className="font-mono text-sm font-medium text-foreground">
                  {selected.ip}
                </span>
                <span className="text-xs text-muted-foreground">
                  {formText(selected)} · {selected.port}
                </span>
              </span>
              : <span className="truncate text-sm text-muted-foreground">
                从环境管理选择环境…
              </span>}
            <ChevronDown aria-hidden
              className={`size-4 shrink-0 text-muted-foreground transition-transform${open ? " rotate-180" : ""}`} />
          </button>
        } />
      {/* 弹层 portal 到 body:必须自带 .tw-root 归一(见文件头说明)。 */}
      <PopoverContent align="start"
        className="tw-root w-(--anchor-width) p-0">
        <div className="border-b border-line p-2">
          <input value={query} autoFocus
            className={envControlClass}
            placeholder="搜索 IP、标签或形态…"
            aria-label="搜索环境"
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlighted(-1);
            }}
            onKeyDown={onSearchKeyDown} />
        </div>
        <div ref={listRef} className="max-h-60 overflow-y-auto p-1" role="listbox"
          aria-label="环境清单">
          {error && <p className="m-1 rounded-md border border-destructive/40 bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
            {error}
          </p>}
          {loading
            ? <p className="px-3 py-3 text-sm text-muted-foreground">环境列表加载中…</p>
            : filtered.map((entry, index) => {
              const picked = entry.id === selectedId;
              return <button type="button" key={entry.id} role="option"
                aria-selected={picked}
                data-highlighted={index === highlighted ? "true" : undefined}
                className={`flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent${index === highlighted ? " bg-accent" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(entry)}>
                <span className="flex w-full items-center gap-2">
                  <span className="font-mono font-medium text-foreground"
                    title={`端口 ${entry.port}`}>{entry.ip}</span>
                  <span className="text-xs text-muted-foreground">
                    {formText(entry)} · {entry.port}
                  </span>
                  {picked && <Check aria-hidden className="ml-auto size-4 text-ink" />}
                </span>
                {entry.tags.length > 0 && <span className="flex flex-wrap gap-1">
                  {entry.tags.map((tag) => <span key={tag}
                    className="rounded-full border border-line px-1.5 text-xs text-muted-foreground">
                    {tag}
                  </span>)}
                </span>}
              </button>;
            })}
          {!loading && filtered.length === 0 && <div
            className="flex flex-col gap-0.5 px-3 py-2.5">
            <p className="text-sm text-foreground">
              {environments.length === 0
                ? "还没有登记过任何环境"
                : <>没有匹配「{query.trim()}」的环境</>}
            </p>
            <p className="text-xs text-muted-foreground">
              {environments.length === 0
                ? "在「环境管理」里登记一台网管环境,以后在这里直接选。"
                : "换个关键词,或者直接新增一台。"}
            </p>
          </div>}
        </div>
        <div className="border-t border-line p-1">
          <Button type="button" variant="ghost" size="sm"
            className="w-full justify-start text-muted-foreground hover:text-foreground"
            onClick={() => {
              setOpen(false);
              setEditor({});
            }}>
            <Plus aria-hidden />新增环境…
          </Button>
        </div>
      </PopoverContent>
    </Popover>
    {editor && <EnvironmentEditorDialog
      key={editor.existing?.id ?? "create"}
      existing={editor.existing}
      environments={environments}
      onClose={() => setEditor(undefined)}
      onSaved={saved}
      onProbed={(updated) => setEnvironments((prev) =>
        prev.map((item) => (item.id === updated.id ? updated : item)))}
      onSwitchTo={(entry) => setEditor({ existing: entry })}
    />}
  </div>;
}

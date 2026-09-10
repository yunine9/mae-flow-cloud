/**
 * 环境快选(票 #150,ADR-0020):从环境管理台账选一条环境的共用选择器
 * ——登记页「从环境管理选」与 env_needed 闸卡的台账快选列表共用本组件。
 *
 * 零密码契约:台账视图(EnvironmentView)没有任何密码字段,这里展示与
 * 提交的只有非密元信息(IP/形态/标签/端口);选中后只上送条目 id,值由
 * 服务端从台账解密快照进会话 vault(选入即快照,台账后续改/删不影响
 * 已进行的会话)。新 UI 一律 Tailwind(#146):根元素挂 .tw-root 做
 * scoped 归一,颜色/字号/圆角全走 @theme 桥映射出的令牌工具类。
 */
import { useEffect, useState } from "react";
import {
  listEnvironments,
  type EnvironmentForm,
  type EnvironmentView,
} from "./api";

/** 环境形态的页面文案(与登记表单/闸卡下拉同词)。 */
const FORM_TEXT: Record<EnvironmentForm, string> = {
  virtualized: "虚拟化",
  k8s: "容器化(K8s)",
};

const pickRowClass =
  "flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-sm "
  + "transition-colors focus-visible:outline-none focus-visible:ring-[3px] "
  + "focus-visible:ring-ring/50";
/** 未选中行:中性描边,悬停亮起;选中行:主动作描边 + 弱化底。 */
const rowIdleClass = "border-line bg-transparent hover:border-line-strong hover:bg-surface-2";
const rowPickedClass = "border-ink bg-surface-2";

export function EnvironmentPicker({ selectedId, onPick, onManual }: {
  /** 当前选中的台账条目 id(受控;空 = 未选)。 */
  selectedId?: string | null;
  /** 选中一条台账环境(上送 environment_id,值由服务端快照)。 */
  onPick: (entry: EnvironmentView) => void;
  /** 「手动填写」回退入口(闸卡用);缺席不渲染。 */
  onManual?: () => void;
}) {
  const [environments, setEnvironments] = useState<EnvironmentView[]>();
  const [error, setError] = useState("");
  const [loadingId, setLoadingId] = useState("");

  async function load() {
    setLoadingId("list");
    try {
      setEnvironments(await listEnvironments());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "环境台账加载失败");
    } finally {
      setLoadingId("");
    }
  }
  useEffect(() => { void load(); }, []);

  return <div className="tw-root flex flex-col gap-2 text-base text-foreground"
    aria-label="从环境管理选择">
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm font-medium text-foreground">从环境管理选</span>
      <div className="flex items-center gap-1">
        <button type="button"
          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => void load()} disabled={loadingId === "list"}>
          {loadingId === "list" ? "刷新中…" : "刷新"}
        </button>
        {onManual && <button type="button"
          className="rounded-md border border-line px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={onManual}>
          手动填写
        </button>}
      </div>
    </div>

    {error && <p className="rounded-md border border-destructive/40 bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
      {error}
    </p>}

    {environments === undefined
      ? <p className="text-sm text-muted-foreground">环境台账加载中…</p>
      : environments.length === 0
        ? <div className="flex flex-col items-start gap-1 rounded-lg border border-dashed border-line px-4 py-4">
          <p className="text-sm text-foreground">台账里还没有环境</p>
          <p className="text-sm text-muted-foreground">
            先到「环境管理」页签录入环境(IP、形态、端口、后台密码),
            之后这里就能快选;也可以{onManual ? "点右上「手动填写」直接填。" : "在登记表单里手动填写。"}
          </p>
        </div>
        : <div className="flex flex-col gap-1.5" role="radiogroup"
          aria-label="环境台账快选列表">
          {environments.map((entry) => {
            const picked = entry.id === selectedId;
            return <button type="button" key={entry.id} role="radio"
              aria-checked={picked}
              className={`${pickRowClass} ${picked ? rowPickedClass : rowIdleClass}`}
              onClick={() => onPick(entry)}>
              <span className="font-mono text-sm text-foreground"
                title={`端口 ${entry.port}`}>{entry.ip}</span>
              <span className="text-xs text-muted-foreground">
                {FORM_TEXT[entry.form] ?? entry.form} · {entry.port}
              </span>
              {entry.tags.map((tag) => <span key={tag}
                className="rounded-full border border-line px-2 py-0.5 text-xs text-muted-foreground">
                {tag}
              </span>)}
              {picked && <span className="ml-auto text-xs text-ink">已选</span>}
            </button>;
          })}
        </div>}
  </div>;
}

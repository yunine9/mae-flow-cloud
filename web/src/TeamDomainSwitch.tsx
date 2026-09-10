/**
 * 团队任务页「领域即标题」切换器(正式实现,2026-09-10;原型
 * TeamDomainSwitchPrototype 五稿确认后折入,原型文件已退场)。
 *
 * 页头 h1 就是领域下拉:需求域=需求交付(原页面原样),问题域=问题处理
 * (整页换成问题世界——两域页面的分支渲染在 App.tsx,本组件只管标题位
 * 下拉与领域选择的持久化)。
 *
 * h1 接管方式(9f926bf 的事故教训,自原型逐字继承):绝不碰 React 管理
 * 的节点——不对 h1 做 textContent 清空(那会删掉它的文本子节点,此后
 * 任何从团队页出发的视图切换,React 提交时对已失踪子节点执行
 * removeChild 当场崩进错误边界)。只做两件事:h1 置 display:none,在它
 * 后面插入自有的宿主 span 渲染下拉;卸载时恢复 h1、移除宿主。
 *
 * 样式(#146):Tailwind 工具类 + components/ui 的 shadcn 组件皮,弹层
 * portal 到 body、自带 .tw-root 归一;不新增 legacy css。颜色一律走
 * tailwind.css 桥的令牌:需求域=ink(主动作紫,原型的 var(--accent)),
 * 问题域=success(语义绿——原型的问题域色是硬编码的青绿,按令牌纪律
 * 折到最近的语义令牌,不引新色)。
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { issueDeliveryBreakdown } from "./teamOps";

export type TeamDomain = "req" | "issue";

const TEAM_DOMAIN_STORAGE_KEY = "mae-flow:team-domain";
const TEAM_DOMAIN_TEXT: Record<TeamDomain, string> = {
  req: "需求交付",
  issue: "问题处理",
};

/** 领域选择记在本机,下次进团队页沿用(与任务排序记忆同款纪律)。 */
export function readTeamDomain(): TeamDomain {
  try {
    const saved = localStorage.getItem(TEAM_DOMAIN_STORAGE_KEY);
    if (saved === "req" || saved === "issue") return saved;
  } catch { /* localStorage 不可用(隐私模式等)就回默认域 */ }
  return "req";
}

export function persistTeamDomain(domain: TeamDomain): void {
  try { localStorage.setItem(TEAM_DOMAIN_STORAGE_KEY, domain); } catch { /* 同上 */ }
}

/** 一域一皮:触发器色块、选项字形块、选中态与对勾的颜色族。 */
const DOMAIN_TONE: Record<TeamDomain, {
  block: string; glyph: string; selected: string; hover: string; check: string;
}> = {
  req: {
    block: "bg-ink",
    glyph: "bg-ink/15 text-ink",
    selected: "bg-ink/10",
    hover: "hover:bg-ink/5",
    check: "text-ink",
  },
  issue: {
    block: "bg-success",
    glyph: "bg-success/15 text-success",
    selected: "bg-success/10",
    hover: "hover:bg-success/5",
    check: "text-success",
  },
};

export function TeamDomainSwitch({ domain, onSelect, tasks, issues }: {
  domain: TeamDomain;
  onSelect: (next: TeamDomain) => void;
  /** 统计只需稳定字段(自包含形状,与 teamOps 的投影口径一致)。 */
  tasks: ReadonlyArray<{ status: string }>;
  issues: ReadonlyArray<{ status: string; stage?: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [titleHost, setTitleHost] = useState<HTMLElement | null>(null);

  // 标题位接管:隐藏 React 的 h1 + 在它后面安自有宿主(见文件头教训)。
  useEffect(() => {
    const h1 = document.querySelector<HTMLElement>(".workspace-header h1");
    if (!h1) return;
    const host = document.createElement("span");
    h1.insertAdjacentElement("afterend", host);
    h1.style.display = "none";
    setTitleHost(host);
    return () => {
      h1.style.display = "";
      host.remove();
      setTitleHost(null);
    };
  }, []);

  const reqStats = {
    delivering: tasks.filter((task) =>
      task.status !== "canceled" && task.status !== "completed").length,
    delivered: tasks.filter((task) => task.status === "completed").length,
  };
  const issueStats = issueDeliveryBreakdown(issues);
  const tone = DOMAIN_TONE[domain];

  const option = (value: TeamDomain, glyph: string, name: string, stats: string) => {
    const optionTone = DOMAIN_TONE[value];
    const selected = domain === value;
    return <button type="button" role="option" aria-selected={selected} key={value}
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${optionTone.hover} ${selected ? optionTone.selected : ""}`}
      onClick={() => { onSelect(value); setOpen(false); }}>
      <span aria-hidden className={`grid size-9 flex-none place-items-center rounded-lg text-base font-bold ${optionTone.glyph}`}>
        {glyph}
      </span>
      <span className="grid min-w-0 gap-0.5">
        <strong className="text-sm font-bold text-text-strong">{name}</strong>
        <small className="text-xs text-muted-foreground">{stats}</small>
      </span>
      {selected && <Check aria-hidden className={`ml-auto size-4 flex-none ${optionTone.check}`} />}
    </button>;
  };

  // 弹层 portal 到 body(tw-root 自归一);触发器 portal 进页头宿主,
  // 宿主子树同样 tw-root 归一,不吃 legacy 全局默认。
  return titleHost && createPortal(
    <span className="tw-root inline-flex items-center">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          {/* 标题即切换器:浅底胶囊 + 领域色块 + 加粗域名 + 旋转箭头给可点暗示。 */}
          <button type="button" aria-haspopup="listbox" aria-expanded={open}
            title="切换工作流领域"
            className={`inline-flex items-center gap-2.5 rounded-lg bg-ink/5 py-1 pl-2.5 pr-3.5 font-bold text-text-strong transition-colors ${domain === "req" ? "hover:bg-ink/10" : "hover:bg-success/10"}`}>
            <span aria-hidden className={`size-3 rounded-sm ${tone.block}`} />
            <span className="text-base">{TEAM_DOMAIN_TEXT[domain]}</span>
            <ChevronDown aria-hidden
              className={`size-3 text-muted-foreground transition-transform${open ? " rotate-180" : ""}`} />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="tw-root w-80 p-1.5">
          <div role="listbox" aria-label="工作流领域" className="flex flex-col">
            {option("req", "需", "需求交付",
              `交付中 ${reqStats.delivering} · 已交付 ${reqStats.delivered}`)}
            {option("issue", "问", "问题处理",
              `处理中 ${issueStats.active} · 待答复 ${issueStats.waiting} · 已闭环 ${issueStats.closed}`)}
          </div>
        </PopoverContent>
      </Popover>
    </span>, titleHost);
}

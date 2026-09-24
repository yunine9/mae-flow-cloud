/**
 * 表头列筛选的共用壳(先住 EnvironmentRegistry,2026-09-13 DTS 列表
 * 筛选表头化时抽出两页共用):漏斗钮 + 弹层,激活的漏斗给 accent 小
 * 底块——哪列在筛,一眼可辨。弹层 portal 到 body,内容必须自带
 * .tw-root 归一(同 EnvironmentPicker 的教训)。children 拿 close(),
 * 选项类选完即关,文本输入类忽略。
 */
import { useState, type ReactNode } from "react";
import { Filter } from "lucide-react";
import { cn } from "cn";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export function HeaderFilter({ label, active, onClear, clearLabel, contentClassName, children }: {
  label: string;
  active: boolean;
  /** 本列的清除动作:给了才在弹层底部出清除入口。 */
  onClear?: () => void;
  /** 清除入口的措辞(缺省「清除此列筛选」;过滤入口不在列头上时自定义)。 */
  clearLabel?: string;
  /** 弹层宽度覆盖(缺省 w-40):多选清单类内容可放宽。 */
  contentClassName?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger
      render={
        <button type="button" aria-label={`筛选 ${label}`}
          title={active ? `筛选 ${label}(生效中,点开可清除)` : `筛选 ${label}`}
          aria-pressed={active}
          className={active
            ? "rounded-sm bg-accent px-0.5 text-ink"
            : "text-muted-foreground hover:text-foreground"}>
          <Filter aria-hidden className="size-3.5" />
        </button>
      } />
    <PopoverContent align="start" className={cn("tw-root p-1", contentClassName ?? "w-40")}>
      {children(() => setOpen(false))}
      {active && onClear && <div className="border-t border-line pt-1 mt-1">
        <button type="button"
          className="w-full rounded-md px-2 py-1 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => {
            onClear();
            setOpen(false);
          }}>{clearLabel ?? "清除此列筛选"}</button>
      </div>}
    </PopoverContent>
  </Popover>;
}

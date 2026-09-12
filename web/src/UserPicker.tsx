/**
 * 人员选择（票 #211 shadcn 化）：姓名用于阅读，工号仍是身份；几十人时直接搜索。
 *
 * 对外契约不变：UserOption / userLabel / 全部 props 与 onChange(username)
 * 签名原样，消费点零改动。内部从手写组合框换成 shadcn combobox 范式 =
 * Popover + Command（cmdk，同 EnvironmentPicker #212）：开合、外点关闭、
 * Escape 交给 Popover；搜索、键盘上下选择、IME 组合期回车保护、空态交给
 * CommandInput/CommandList/CommandItem/CommandEmpty——手写的 document
 * mousedown、Escape onKeyDown、role=listbox 选项按钮全部删除。
 * 交互口径保持：匹配口径（display_name+username 包含、大小写不敏感）不变，
 * shouldFilter=false 仍由自己过滤；超过 6 项才出搜索框；禁用项 disabled
 * 不可选；详情行（em）与「姓名（工号）」双行渲染原样保留。
 */
import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

export interface UserOption {
  username: string;
  display_name?: string;
  disabled?: boolean;
  detail?: string;
}

export function userLabel(user: Pick<UserOption, "username" | "display_name">): string {
  return user.display_name
    ? `${user.display_name}（${user.username}）`
    : user.username;
}

/** 搜索框与触发器共用的控件皮（shadcn input 同款配方，同 EnvironmentPicker）。 */
const userControlClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm "
  + "shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] "
  + "focus-visible:ring-ring/50";

export function UserPicker({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  placeholder = "搜索姓名或工号",
  emptyLabel = "请选择成员",
}: {
  value: string;
  options: UserOption[];
  onChange: (username: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  placeholder?: string;
  emptyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = options.find((item) => item.username === value)
    ?? (value ? { username: value } : undefined);
  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return options;
    return options.filter((item) => `${item.display_name ?? ""}\n${item.username}`
      .toLocaleLowerCase().includes(needle));
  }, [options, query]);
  const searchable = options.length > 6;

  return <div className="tw-root min-w-0">
    <Popover open={open} onOpenChange={(next) => {
      setOpen(next);
      if (next) setQuery("");
    }}>
      <PopoverTrigger
        render={<button type="button" disabled={disabled}
          className={`${userControlClass} flex items-center justify-between gap-2 text-left`}
          aria-label={ariaLabel} aria-expanded={open}>
          <span className="min-w-0 truncate">{selected ? userLabel(selected) : emptyLabel}</span>
          <ChevronDown aria-hidden
            className={`size-4 shrink-0 text-muted-foreground transition-transform${open ? " rotate-180" : ""}`} />
        </button>} />
      {/* 弹层 portal 到 body：必须自带 .tw-root 归一（见 EnvironmentPicker 文件头）。 */}
      <PopoverContent align="start"
        className="tw-root w-(--anchor-width) min-w-60 gap-0 p-0">
        <Command shouldFilter={false} className="rounded-lg!">
          {searchable && <CommandInput value={query} onValueChange={setQuery}
            autoFocus placeholder={placeholder} aria-label={`${ariaLabel}搜索`} />}
          <CommandList aria-label={ariaLabel} className="max-h-44">
            {shown.map((item) => <CommandItem key={item.username}
              value={item.username} disabled={item.disabled}
              data-checked={item.username === value || undefined}
              onSelect={() => { onChange(item.username); setOpen(false); setQuery(""); }}
              className="py-2">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <strong className="truncate text-[12.5px] font-medium text-foreground">
                  {item.display_name ?? item.username}
                </strong>
                {item.display_name
                  && <small className="truncate text-xs text-muted-foreground">{item.username}</small>}
              </span>
              {item.detail && <em className="max-w-[104px] shrink-0 truncate text-xs not-italic text-muted-foreground">
                {item.detail}
              </em>}
            </CommandItem>)}
            <CommandEmpty>没有匹配的成员</CommandEmpty>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  </div>;
}

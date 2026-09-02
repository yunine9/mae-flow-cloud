import { useEffect, useMemo, useRef, useState } from "react";

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
  const root = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return <div className={`user-picker${open ? " open" : ""}`} ref={root}>
    <button type="button" className="user-picker-value" disabled={disabled}
      aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open}
      onClick={() => { setOpen((current) => !current); setQuery(""); }}>
      <span>{selected ? userLabel(selected) : emptyLabel}</span>
      <i aria-hidden>⌄</i>
    </button>
    {open && <div className="user-picker-popover"
      onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>
      {searchable && <input autoFocus value={query} aria-label={`${ariaLabel}搜索`}
        placeholder={placeholder}
        onChange={(event) => setQuery(event.target.value)} />}
      <div className="user-picker-options" role="listbox" aria-label={ariaLabel}>
        {shown.map((item) => <button type="button" role="option"
          aria-selected={item.username === value} key={item.username}
          disabled={item.disabled}
          onClick={() => { onChange(item.username); setOpen(false); setQuery(""); }}>
          <span><strong>{item.display_name ?? item.username}</strong>
            {item.display_name && <small>{item.username}</small>}</span>
          {item.detail && <em>{item.detail}</em>}
        </button>)}
        {!shown.length && <p>没有匹配的成员</p>}
      </div>
    </div>}
  </div>;
}

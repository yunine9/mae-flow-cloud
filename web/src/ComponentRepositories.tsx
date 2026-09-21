import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  KNOWLEDGE_LANGUAGE_OPTIONS,
  knowledgeLanguageLabel,
} from "./KnowledgeLanguages";
import {
  componentRequest,
  type ComponentRepository,
} from "./componentResearchApi";
export function ComponentRepositories() {
  const [rows, setRows] = useState<ComponentRepository[]>([]),
    [edit, setEdit] = useState<Partial<ComponentRepository>>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState("");
  const load = () =>
    componentRequest<{ components: ComponentRepository[] }>(
      "/component-repositories",
    ).then((r) => setRows(r.components));
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  const languages = KNOWLEDGE_LANGUAGE_OPTIONS.map((l) => ({
    value: l.id,
    label: l.label,
  }));
  return (
    <section className="rounded-xl border border-line bg-surface p-5 text-base">
      <div className="mb-5 flex items-center gap-3">
        <Input
          className="max-w-md"
          aria-label="搜索基础组件"
          placeholder="搜索组件、仓库或语言"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button
          className="ml-auto"
          onClick={() => {
            setError("");
            setEdit({
              name: "",
              repository: "",
              branch: "master",
              path: "",
              languages: [],
              description: "",
              enabled: true,
            });
          }}
        >
          ＋ 新建基础组件仓
        </Button>
      </div>
      <p className="mb-5 text-muted-foreground">
        维护可研究的源码范围与语言。按需同步源码、查找真实调用，提炼为待审查的知识草稿。所有团队成员均可维护。
      </p>
      {error && (
        <p role="alert" className="mb-3 text-danger">
          {error}
        </p>
      )}
      <div className="grid gap-3">
        {rows
          .filter((r) =>
            `${r.name} ${r.repository} ${r.languages.join(" ")}`
              .toLowerCase()
              .includes(query.toLowerCase()),
          )
          .map((row) => (
            <article
              key={row.id}
              className="flex items-center gap-5 rounded-lg border border-line p-4"
            >
              <div className="min-w-0 flex-1">
                <h3 className="font-semibold">
                  {row.name}
                  {!row.enabled && (
                    <span className="ml-3 text-muted-foreground">已停用</span>
                  )}
                </h3>
                <p className="my-2 break-all text-sm text-muted-foreground">
                  {row.repository} · {row.branch} · {row.path || "根目录"}
                </p>
                <p>{row.languages.map(knowledgeLanguageLabel).join(" / ")}</p>
              </div>
              <Button
                variant="outline"
                onClick={() => {
                  setError("");
                  setEdit(row);
                }}
              >
                编辑
              </Button>
              <Button
                disabled={!row.enabled}
                onClick={() =>
                  location.assign(
                    `/?knowledgeDocuments=1&componentResearch=new`,
                  )
                }
              >
                萃取知识
              </Button>
            </article>
          ))}
      </div>
      {!rows.length && (
        <p className="p-12 text-center text-muted-foreground">
          添加一个组件仓，开始积累真实开发范式
        </p>
      )}
      <Dialog
        open={!!edit}
        onOpenChange={(open) => {
          if (!open && !busy) setEdit(undefined);
        }}
      >
        <DialogContent className="tw-root w-[720px] sm:max-w-[720px] max-h-[85vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>{edit?.id ? "编辑" : "新建"}基础组件仓</DialogTitle>
          </DialogHeader>
          {edit && (
            <form
              className="grid gap-4 text-base"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setError("");
                try {
                  await componentRequest("/component-repositories", edit);
                  await load();
                  setEdit(undefined);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {[
                ["name", "组件名称"],
                ["repository", "代码仓地址（HTTP / HTTPS）"],
                ["branch", "分支"],
                ["path", "组件目录（留空表示根目录）"],
              ].map(([key, label]) => (
                <label key={key} className="grid gap-2">
                  {label}
                  <Input
                    required={key !== "path"}
                    value={String(edit[key as keyof ComponentRepository] ?? "")}
                    onChange={(e) =>
                      setEdit({ ...edit, [key]: e.target.value })
                    }
                  />
                </label>
              ))}
              <label className="grid gap-2">
                适用语言
                <Select
                  multiple
                  value={edit.languages ?? []}
                  items={languages}
                  onValueChange={(v) => setEdit({ ...edit, languages: v })}
                >
                  <SelectTrigger aria-label="组件适用语言" className="w-full">
                    <SelectValue placeholder="选择语言，可多选" />
                  </SelectTrigger>
                  <SelectContent>
                    {languages.map((l) => (
                      <SelectItem key={l.value} value={l.value}>
                        {l.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="grid gap-2">
                组件说明
                <Textarea
                  placeholder="可说明对外接口约定，例如优先研究 interface/；impl/ 仅供内部使用。目录是研究线索，仍需核对发布依据。"
                  value={edit.description ?? ""}
                  onChange={(e) =>
                    setEdit({ ...edit, description: e.target.value })
                  }
                />
              </label>
              <label className="flex gap-2">
                <input
                  type="checkbox"
                  checked={edit.enabled !== false}
                  onChange={(e) =>
                    setEdit({ ...edit, enabled: e.target.checked })
                  }
                />
                启用
              </label>
              {error && (
                <p role="alert" className="text-danger">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-3">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setEdit(undefined)}
                >
                  取消
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? "保存中…" : "保存"}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

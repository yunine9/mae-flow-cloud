import { useMemo, useState } from "react";
import type { WorkflowAssetCatalogItem } from "../api";
import { assetKey, registryLabels } from "./model";

type AssetCategory = "all" | "business" | "engineering" | "skill" | "capability";

export function AssetPicker({
  assets,
  selectedKey,
  onSelect,
  onClose,
  title = "选择要使用的资产",
}: {
  assets: WorkflowAssetCatalogItem[];
  selectedKey?: string;
  onSelect: (asset: WorkflowAssetCatalogItem) => void;
  onClose?: () => void;
  title?: string;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<AssetCategory>("all");
  const visible = useMemo(() => assets.filter((asset) => {
    const needle = query.trim().toLocaleLowerCase();
    const matchesQuery = !needle || [asset.title, asset.summary, asset.ref.id,
      asset.when_to_use ?? "", ...asset.technologies].join(" ")
      .toLocaleLowerCase().includes(needle);
    const matchesCategory = category === "all"
      || (category === "business" && asset.nature === "business")
      || (category === "engineering" && asset.nature === "engineering")
      || (category === "skill" && asset.type === "skill")
      || (category === "capability"
        && ["agent", "tool", "capability"].includes(asset.type));
    return matchesQuery && matchesCategory;
  }), [assets, category, query]);

  return <section className="wf-asset-picker" aria-labelledby="wf-asset-picker-title">
    <header>
      <div><span>资产目录</span><h3 id="wf-asset-picker-title">{title}</h3></div>
      {onClose && <button type="button" aria-label="关闭资产选择" onClick={onClose}>×</button>}
    </header>
    <label className="wf-search">
      <span aria-hidden>⌕</span>
      <input value={query} onChange={(event) => setQuery(event.target.value)}
        placeholder="按名称、用途或技术搜索" />
    </label>
    <div className="wf-filter-row" aria-label="资产分类">
      {([ ["all", "全部"], ["business", "业务知识"],
        ["engineering", "工程知识"], ["skill", "Skill"],
        ["capability", "Agent / 工具"] ] as const).map(([value, label]) =>
        <button key={value} type="button" aria-pressed={category === value}
          onClick={() => setCategory(value)}>{label}</button>)}
    </div>
    <div className="wf-asset-results">
      {visible.map((asset) => {
        const unavailable = asset.availability === "unavailable";
        return <button type="button" key={assetKey(asset.ref)}
          className={selectedKey === assetKey(asset.ref) ? "selected" : ""}
          disabled={unavailable} onClick={() => onSelect(asset)}>
          <span className="wf-asset-title">
            <strong>{asset.title}</strong>
            <em>{unavailable ? "不可用" : registryLabels[asset.ref.registry]}</em>
          </span>
          <small>{asset.summary}</small>
          {asset.when_to_use && <span className="wf-asset-when">
            <b>使用时机</b>{asset.when_to_use}</span>}
          <span className="wf-asset-meta">
            <b>{asset.ref.version}</b>
            <b title={asset.ref.digest}>摘要 {asset.ref.digest.slice(0, 8)}</b>
            {asset.ref.repository && <b title={asset.ref.repository}>
              {shortRepository(asset.ref.repository)}</b>}
            {asset.technologies.slice(0, 2).map((item) => <b key={item}>{item}</b>)}
          </span>
          {asset.warning && <span className="wf-warning">{asset.warning}</span>}
        </button>;
      })}
      {!visible.length && <div className="wf-empty compact">
        <strong>没有匹配的资产</strong>
        <span>换个关键词或分类；不可用资产不会被静默加入。</span>
      </div>}
    </div>
  </section>;
}

function shortRepository(repository: string): string {
  return repository.replace(/\/+$/, "").split("/").at(-1)?.replace(/\.git$/i, "")
    || repository;
}

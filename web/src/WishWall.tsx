import { useEffect, useMemo, useRef, useState } from "react";
import {
  createWish,
  deleteWish,
  listWishes,
  setWishStatus,
  setWishVote,
  type WishImageUpload,
  type WishKind,
  type WishStatus,
  type WishWallItem,
} from "./api";
import { formatLocalDateTime, relativeTime } from "./time";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const IMAGE_LIMIT = 4;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

interface ImageDraft {
  key: string;
  file: File;
  preview: string;
}

type Scope = "all" | WishKind;
type Sort = "recent" | "popular";

const STATUS_COPY: Record<WishStatus, { label: string; hint: string }> = {
  open: { label: "待回应", hint: "已收进墙里，等待明确答复" },
  accepted: { label: "已接纳", hint: "这件事会进入后续安排" },
  done: { label: "已闭环", hint: "已经处理完成，可以回来验收" },
  declined: { label: "暂不接纳", hint: "当前不处理，并附有原因" },
};

function fileToUpload(file: File): Promise<WishImageUpload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`读取图片 ${file.name || "截图"} 失败`));
    reader.onload = () => {
      const value = String(reader.result ?? "");
      const comma = value.indexOf(",");
      if (comma < 0) reject(new Error("图片编码失败"));
      else resolve({ mime_type: file.type, content_base64: value.slice(comma + 1) });
    };
    reader.readAsDataURL(file);
  });
}

function StatusPath({ item }: { item: WishWallItem }) {
  const accepted = item.status === "accepted" || item.status === "done";
  return <div className={`wish-status-path is-${item.status}`}
    aria-label={`当前状态：${STATUS_COPY[item.status].label}`}>
    <span className="reached"><i />已发布</span>
    <b aria-hidden />
    <span className={accepted ? "reached" : item.status === "declined" ? "declined" : ""}>
      <i />{item.status === "declined" ? "暂不接纳" : "已接纳"}
    </span>
    <b aria-hidden />
    <span className={item.status === "done" ? "reached" : ""}><i />已闭环</span>
  </div>;
}

export function WishWall({ viewer }: { viewer: { username: string; role: string } }) {
  const [items, setItems] = useState<WishWallItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [kind, setKind] = useState<WishKind>("wish");
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [images, setImages] = useState<ImageDraft[]>([]);
  const imageRef = useRef<ImageDraft[]>([]);
  const [composerError, setComposerError] = useState("");
  const [notice, setNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [scope, setScope] = useState<Scope>("all");
  const [sort, setSort] = useState<Sort>("recent");
  const [busyId, setBusyId] = useState("");
  const [lightbox, setLightbox] = useState<{ url: string; title: string }>();
  const [manage, setManage] = useState<{
    id: string;
    status: WishStatus;
    note: string;
  }>();

  useEffect(() => { imageRef.current = images; }, [images]);
  useEffect(() => () => {
    imageRef.current.forEach((image) => URL.revokeObjectURL(image.preview));
  }, []);

  async function refresh(): Promise<void> {
    setLoadError("");
    try { setItems(await listWishes()); }
    catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "许愿墙加载失败");
    } finally { setLoading(false); }
  }

  useEffect(() => { void refresh(); }, []);

  function addFiles(files: File[]): void {
    setComposerError("");
    const accepted: ImageDraft[] = [];
    for (const file of files) {
      if (!IMAGE_TYPES.includes(file.type)) {
        setComposerError("图片仅支持 PNG、JPG、WebP 或 GIF");
        continue;
      }
      if (file.size > IMAGE_MAX_BYTES) {
        setComposerError(`${file.name || "这张图片"} 超过 5 MB，请压缩后再试`);
        continue;
      }
      if (images.length + accepted.length >= IMAGE_LIMIT) {
        setComposerError(`一条最多放 ${IMAGE_LIMIT} 张图片`);
        break;
      }
      accepted.push({
        key: `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`,
        file,
        preview: URL.createObjectURL(file),
      });
    }
    if (accepted.length) setImages((current) => [...current, ...accepted]);
  }

  function removeImage(key: string): void {
    setImages((current) => {
      const found = current.find((image) => image.key === key);
      if (found) URL.revokeObjectURL(found.preview);
      return current.filter((image) => image.key !== key);
    });
  }

  function handlePaste(event: React.ClipboardEvent): void {
    const files = [...event.clipboardData.items]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (!files.length) return;
    event.preventDefault();
    addFiles(files);
    setNotice(`已粘贴 ${files.length} 张图片`);
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    if (!title.trim()) {
      setComposerError("先写一句标题，让大家一眼看懂");
      return;
    }
    setSubmitting(true); setComposerError(""); setNotice("");
    try {
      const uploads = await Promise.all(images.map((image) => fileToUpload(image.file)));
      const created = await createWish({
        kind, title: title.trim(), detail: detail.trim() || undefined, images: uploads,
      });
      images.forEach((image) => URL.revokeObjectURL(image.preview));
      setImages([]); setTitle(""); setDetail("");
      setItems((current) => [created, ...current]);
      setNotice(kind === "issue" ? "问题已贴上墙，等一个明确回应 🧭" : "愿望已升空，等大家来点亮 ✨");
    } catch (cause) {
      setComposerError(cause instanceof Error ? cause.message : "发布失败，请重试");
    } finally { setSubmitting(false); }
  }

  async function toggleVote(item: WishWallItem): Promise<void> {
    if (busyId) return;
    setBusyId(item.id);
    try {
      const updated = await setWishVote(item.id, !item.viewer_voted);
      setItems((current) => current.map((entry) => entry.id === item.id ? updated : entry));
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "点亮失败，请重试");
    } finally { setBusyId(""); }
  }

  async function saveStatus(): Promise<void> {
    if (!manage || busyId) return;
    if (manage.status === "declined" && !manage.note.trim()) {
      setNotice("暂不接纳时请留一句原因，让提出的人有明确下文");
      return;
    }
    setBusyId(manage.id);
    try {
      const updated = await setWishStatus(manage.id, manage.status, manage.note.trim());
      setItems((current) => current.map((entry) => entry.id === manage.id ? updated : entry));
      setManage(undefined);
      setNotice(`${STATUS_COPY[updated.status].label}，状态已同步给所有人`);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "状态更新失败");
    } finally { setBusyId(""); }
  }

  async function remove(item: WishWallItem): Promise<void> {
    if (busyId || !window.confirm(`移除「${item.title}」？这不会影响其他内容。`)) return;
    setBusyId(item.id);
    try {
      await deleteWish(item.id);
      setItems((current) => current.filter((entry) => entry.id !== item.id));
      setNotice("已从墙上取下");
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "移除失败");
    } finally { setBusyId(""); }
  }

  const shown = useMemo(() => items
    .filter((item) => scope === "all" || item.kind === scope)
    .sort((left, right) => sort === "popular"
      ? right.votes - left.votes || right.created_at.localeCompare(left.created_at)
      : right.created_at.localeCompare(left.created_at)), [items, scope, sort]);
  const acceptedCount = items.filter((item) => item.status === "accepted").length;
  const doneCount = items.filter((item) => item.status === "done").length;

  return <div className="wish-wall" onPaste={handlePaste}>
    <section className="wish-hero">
      <div className="wish-hero-copy">
        <span className="section-kicker">TEAM WISH WALL</span>
        <h2>让每个“小别扭”，都有一个好下文</h2>
        <p>遇到问题、想到改进，随手贴上来。大家一起点亮，负责人明确接纳，完成后公开闭环。</p>
        <div className="wish-hero-stats" aria-label="许愿墙摘要">
          <span><strong>{items.length}</strong> 个声音</span>
          <span><strong>{acceptedCount}</strong> 个已接纳</span>
          <span><strong>{doneCount}</strong> 个已闭环</span>
        </div>
      </div>
      <div className="wish-hero-orbit" aria-hidden>
        <span>✨</span><span>💡</span><span>🛠️</span><i>愿望<br />发射台</i>
      </div>
    </section>

    <form className={`wish-composer${dragging ? " is-dragging" : ""}`} onSubmit={submit}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault(); setDragging(false); addFiles([...event.dataTransfer.files]);
      }}>
      <div className="wish-composer-head">
        <div><span className="wish-pencil" aria-hidden>✦</span><strong>我想说一件事</strong></div>
        <div className="wish-kind-toggle" role="group" aria-label="内容类型">
          <button type="button" className={kind === "wish" ? "on" : ""}
            onClick={() => setKind("wish")}>💫 我有个诉求</button>
          <button type="button" className={kind === "issue" ? "on issue" : ""}
            onClick={() => setKind("issue")}>🧩 我遇到问题</button>
        </div>
      </div>
      <label className="wish-title-field">
        <span>一句话说清楚</span>
        <input value={title} onChange={(event) => setTitle(event.target.value)}
          maxLength={100} placeholder={kind === "issue"
            ? "例如：手机上看任务详情时，代码块会横向溢出"
            : "例如：希望任务完成后能一键生成复盘摘要"} />
        <small>{title.length}/100</small>
      </label>
      <label className="wish-detail-field">
        <span>再补充一点 <small>（可选）</small></span>
        <textarea value={detail} onChange={(event) => setDetail(event.target.value)}
          maxLength={2000} rows={3} placeholder="什么场景下遇到的？你希望它变成什么样？不用写成正式需求。" />
      </label>
      {images.length > 0 && <div className="wish-image-drafts">
        {images.map((image, index) => <figure key={image.key}>
          <img src={image.preview} alt={`待发布图片 ${index + 1}`} />
          <button type="button" onClick={() => removeImage(image.key)}
            aria-label={`移除第 ${index + 1} 张图片`}>×</button>
        </figure>)}
      </div>}
      <div className="wish-composer-foot">
        <label className="wish-image-picker">
          <input type="file" accept={IMAGE_TYPES.join(",")} multiple onChange={(event) => {
            addFiles([...(event.target.files ?? [])]); event.target.value = "";
          }} />
          <span aria-hidden>▧</span> 添加图片
        </label>
        <span className="wish-paste-hint"><kbd>⌘</kbd><kbd>V</kbd> 直接粘贴截图，也可拖到这里 · 最多 4 张</span>
        <button className="wish-submit" type="submit" disabled={submitting}>
          {submitting ? "正在贴上墙…" : kind === "issue" ? "把问题贴上墙" : "发射这个愿望"}
          <span aria-hidden>↗</span>
        </button>
      </div>
      {dragging && <div className="wish-drop-mask"><strong>放手，图片就留在这里</strong><span>最多 4 张，每张不超过 5 MB</span></div>}
      {composerError && <p className="wish-form-message error" role="alert">{composerError}</p>}
    </form>

    <section className="wish-board" aria-labelledby="wish-board-title">
      <div className="wish-board-toolbar">
        <div><span className="section-kicker">VOICES FROM THE TEAM</span><h2 id="wish-board-title">大家最近在意什么</h2></div>
        <div className="wish-filters">
          <div role="group" aria-label="筛选类型">
            {(["all", "wish", "issue"] as Scope[]).map((value) => <button type="button"
              key={value} className={scope === value ? "on" : ""} onClick={() => setScope(value)}>
              {value === "all" ? "全部" : value === "wish" ? "诉求" : "问题"}
            </button>)}
          </div>
          <select value={sort} onChange={(event) => setSort(event.target.value as Sort)}
            aria-label="排序方式"><option value="recent">最新发布</option><option value="popular">最多点亮</option></select>
        </div>
      </div>
      {notice && <p className="wish-notice" role="status">{notice}<button type="button" onClick={() => setNotice("")} aria-label="关闭提示">×</button></p>}
      {loadError && <div className="wish-load-state error"><strong>墙暂时没加载出来</strong><span>{loadError}</span><button type="button" onClick={() => void refresh()}>再试一次</button></div>}
      {loading && <div className="wish-load-state"><span className="wish-loading-dot" />正在把大家的声音搬过来…</div>}
      {!loading && !loadError && shown.length === 0 && <div className="wish-empty">
        <span aria-hidden>{scope === "issue" ? "🪁" : "🌱"}</span>
        <strong>{items.length ? "这个分类还空着" : "墙面刚刷好，等第一张便利贴"}</strong>
        <p>{items.length ? "换个分类看看，或者把你的想法贴上来。" : "不用想得很完整，一句话也值得被看见。"}</p>
      </div>}
      <div className="wish-card-grid">
        {shown.map((item, index) => <article className={`wish-card ${item.kind} tone-${index % 4}`} key={item.id}>
          <div className="wish-card-pin" aria-hidden />
          <header>
            <span className={`wish-kind ${item.kind}`}>{item.kind === "wish" ? "💫 诉求" : "🧩 问题"}</span>
            <span className={`wish-status is-${item.status}`} title={STATUS_COPY[item.status].hint}>
              <i />{STATUS_COPY[item.status].label}
            </span>
          </header>
          <h3>{item.title}</h3>
          {item.detail && <p className="wish-card-detail">{item.detail}</p>}
          {item.images.length > 0 && <div className={`wish-card-images count-${Math.min(item.images.length, 3)}`}>
            {item.images.map((image, imageIndex) => <button type="button" key={image.id}
              onClick={() => setLightbox({ url: image.url, title: `${item.title} · 图片 ${imageIndex + 1}` })}>
              <img src={image.url} alt={`${item.title}的补充图片 ${imageIndex + 1}`} loading="lazy" />
            </button>)}
          </div>}
          <StatusPath item={item} />
          {item.decision_note && <blockquote className={`wish-decision is-${item.status}`}>
            <span>{item.status === "declined" ? "暂不接纳说明" : item.status === "done" ? "闭环反馈" : "处理反馈"}</span>
            <p>{item.decision_note}</p>
            <footer>{item.decided_by} · {formatLocalDateTime(item.decided_at)}</footer>
          </blockquote>}
          <footer className="wish-card-foot">
            <span className="wish-author"><i aria-hidden>{item.author.slice(0, 1).toUpperCase()}</i><span><strong>{item.author}</strong><small title={formatLocalDateTime(item.created_at)}>{relativeTime(item.created_at)}</small></span></span>
            <div className="wish-card-actions">
              <button type="button" className={`wish-vote${item.viewer_voted ? " on" : ""}`}
                disabled={busyId === item.id} aria-pressed={item.viewer_voted}
                onClick={() => void toggleVote(item)} title={item.viewer_voted ? "取消点亮" : "我也期待"}>
                <span aria-hidden>{item.viewer_voted ? "✦" : "☆"}</span>{item.votes || "点亮"}
              </button>
              {item.can_manage && <button type="button" className="wish-manage"
                onClick={() => setManage({ id: item.id, status: item.status, note: item.decision_note ?? "" })}>回应</button>}
              {item.can_delete && <button type="button" className="wish-remove"
                disabled={busyId === item.id} onClick={() => void remove(item)} aria-label={`移除 ${item.title}`}>•••</button>}
            </div>
          </footer>
        </article>)}
      </div>
    </section>

    {lightbox && <div className="wish-lightbox" role="dialog" aria-modal="true" aria-label={lightbox.title}
      onClick={() => setLightbox(undefined)}>
      <button type="button" onClick={() => setLightbox(undefined)} aria-label="关闭图片">×</button>
      <img src={lightbox.url} alt={lightbox.title} onClick={(event) => event.stopPropagation()} />
    </div>}
    {manage && <div className="wish-manage-backdrop" role="dialog" aria-modal="true" aria-labelledby="wish-manage-title"
      onMouseDown={(event) => { if (event.target === event.currentTarget) setManage(undefined); }}>
      <section className="wish-manage-dialog">
        <header><div><span className="section-kicker">MAKE IT CLEAR</span><h2 id="wish-manage-title">给这件事一个明确下文</h2></div><button type="button" onClick={() => setManage(undefined)} aria-label="关闭">×</button></header>
        <div className="wish-status-options" role="group" aria-label="处理状态">
          {(["open", "accepted", "done", "declined"] as WishStatus[]).map((status) => <button
            type="button" key={status} className={manage.status === status ? `on is-${status}` : ""}
            onClick={() => setManage({ ...manage, status })}>
            <i /> <span><strong>{STATUS_COPY[status].label}</strong><small>{STATUS_COPY[status].hint}</small></span>
          </button>)}
        </div>
        <label><span>给提出人的反馈 {manage.status === "declined" ? "（必填）" : "（可选）"}</span>
          <textarea value={manage.note} maxLength={500} rows={4} onChange={(event) => setManage({ ...manage, note: event.target.value })}
            placeholder={manage.status === "declined" ? "请说明现在为什么不做，或者什么条件下会重新考虑" : "例如：已纳入下个迭代；已上线，可在个人设置中体验"} /></label>
        <footer><button type="button" onClick={() => setManage(undefined)}>取消</button><button type="button"
          className="primary" disabled={busyId === manage.id} onClick={() => void saveStatus()}>{busyId === manage.id ? "保存中…" : "确认并公开回应"}</button></footer>
      </section>
    </div>}
  </div>;
}

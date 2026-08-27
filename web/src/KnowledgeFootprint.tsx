import type {
  KnowledgeAction,
  TaskKnowledgeUsage,
} from "./api";

const KIND = {
  rules: "项目规则",
  document: "业务文档",
  skill: "Skill",
} as const;

const ACTION: Record<KnowledgeAction, string> = {
  available: "进入能力目录",
  loaded: "已加载到上下文",
  read: "读取正文",
  searched: "检索定位",
};

const ROLE = {
  main: "主 Agent",
  subagent: "子 Agent",
  prepush: "推送前编译",
  "developer-assistant": "开发助手",
} as const;

function time(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function KnowledgeFootprint({
  usage,
  utMethod,
}: {
  usage?: TaskKnowledgeUsage;
  /** 下单事实「UT生成方式」镜像:是否指向团队 Skill 在这一行说破
   * (实锤:内网对着 task.json 排查 skill 为何没被消费,无处可查)。 */
  utMethod?: string;
}) {
  const consumed = usage?.resources.filter((item) =>
    item.loaded_count > 0 || item.read_count > 0) ?? [];
  return (
    <section className="knowledge-footprint" aria-labelledby="knowledge-footprint-title">
      <header>
        <div className="knowledge-footprint-mark" aria-hidden>知</div>
        <div>
          <span>KNOWLEDGE FOOTPRINT</span>
          <strong id="knowledge-footprint-title">本单知识足迹</strong>
          <p>记录 Agent 实际加载、阅读和检索过的业务知识，不参与流程门禁。</p>
        </div>
        <div className="knowledge-footprint-stats" aria-label="知识消费摘要">
          <span><strong>{usage?.summary.used ?? 0}</strong><small>已消费</small></span>
          <span><strong>{usage?.summary.skills_used ?? 0}</strong><small>Skill 使用</small></span>
          <span><strong>{usage?.events.length ?? 0}</strong><small>足迹事件</small></span>
        </div>
      </header>

      {utMethod && (
        <p className={`knowledge-ut-method${
          utMethod === "仓内既有写法" ? " is-fallback" : ""}`}>
          UT 生成方式:<strong>「{utMethod}」</strong>
          {utMethod === "仓内既有写法"
            ? "——本单未指向任何团队 UT Skill(货架为空或命名未命中 UT 模式),Agent 不读 UT skill 属正确行为。"
            : "——写测试前 Agent 会先读取该 Skill 正文。"}
        </p>
      )}

      {consumed.length ? (
        <div className="knowledge-footprint-resources">
          {consumed.slice(0, 8).map((item) => (
            <article key={item.id} className={`knowledge-resource kind-${item.kind}`}>
              <span>{KIND[item.kind]}</span>
              <strong title={item.name}>{item.name}</strong>
              <code title={item.path}>{item.path}</code>
              <small>{item.read_count > 0
                ? `读取/检索 ${item.read_count} 次`
                : "开局已加载"}</small>
            </article>
          ))}
        </div>
      ) : (
        <div className="knowledge-footprint-empty">
          尚无已消费知识；项目规则、手选文档或 Skill 被加载/读取后会在这里出现。
        </div>
      )}

      {!!usage?.events.length && (
        <details className="knowledge-footprint-events">
          <summary>
            查看消费明细
            <span>{usage.events.length} 条</span>
          </summary>
          <div>
            {usage.events.slice(0, 24).map((event, index) => (
              <article key={`${event.ts}-${event.id}-${index}`}>
                <i className={`kind-${event.kind}`} aria-hidden />
                <time dateTime={event.ts}>{time(event.ts)}</time>
                <strong>{event.name}</strong>
                <span>{ACTION[event.action]}</span>
                <small>{ROLE[event.session_role]}
                  {event.step ? ` · ${event.step}` : ""}</small>
              </article>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

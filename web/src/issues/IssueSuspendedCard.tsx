/**
 * 挂起会话的存量说明卡(ADR-0048):无单会话确认是问题现在直接闭环
 * 归档并产出提单模板,不再挂起、不再关联转正;还在挂起态的是退役前
 * 的存量,走会话操作里的手动归档收口。挂载点与旧关联卡同槽(协作流
 * 区顶部),查看模式同卡——登记人只读也是这一张。
 */

export function IssueSuspendedCard() {
  return <section
    aria-label="存量挂起说明"
    className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px] leading-relaxed">
    <p className="font-semibold text-text-strong">问题已确认成立,会话处于存量挂起态</p>
    <p className="mt-1 text-muted-foreground">
      转正机制已退役:现在确认是问题会直接闭环归档并产出提单模板。
      请在会话操作里用「归档」收口本会话。
    </p>
  </section>;
}

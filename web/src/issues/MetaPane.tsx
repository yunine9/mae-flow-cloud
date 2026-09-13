/**
 * 元信息域(#239 只读版):问题会话工作台首签「元信息」。
 *
 * 上半区只读陈列登记元信息四项——标题、问题描述全文、业务模块名、
 * 网管环境(名称 + IP + 端口 + 形态;形态中文沿用环境域口径
 * 「虚拟化/容器化」,见 EnvironmentEditorDialog 的页面文案)。凭据类
 * 字段绝不出现:凭据只以服务端 vault 引用的形式存在于 wire 上,本
 * 面板连引用都不渲染。空值如实说「(未填)」,不编占位内容。
 *
 * 下半区陈列会话全部关联仓(仓名 + 完整 URL,一仓一行);模块绑定仓
 * (团队资产目录里该 module_id 的 repositories)带「模块绑定」标识。
 * 绑定集合在本组件内经 getBusinessModules 异步解析:目录加载失败/
 * 未登记 module_id/模块不在册一律降级为不出标识,仓清单照列——绑定
 * 标是加分信息,不是清单的前提。
 *
 * repo_reclaimed_at 在场(磁盘治理:终态单的 repo/ 被清扫器回收)时,
 * 清单区如实标注「现场已回收」,不冒充在场。
 *
 * 本票零写口(整个面板就是只读陈列,项目原则:UI 只做状态显示);
 * #241 的登记信息编辑器将来挂文末的编辑区挂载点——挂载点受终态闸门
 * 控制,终态会话(archived/canceled,failed 按会话域既有终局口径一并
 * 算)永远不渲染任何编辑入口。
 */
import { useEffect, useState, type ReactNode } from "react";
import { getBusinessModules, type IssueDetail } from "../api";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription } from "@/components/Empty";
import { formatLocalDateTime } from "../time";
import { repoName } from "./perRepo";
import { ENVIRONMENT_FORM_TEXT } from "../EnvironmentEditorDialog";

/** 空值口径:登记面没填的字段如实示人,不编内容。 */
const UNFILLED = "(未填)";

function envTypeText(envType: "virtualized" | "k8s" | undefined): string {
  // 形态中文与编辑弹框同源(ENVIRONMENT_FORM_TEXT:虚拟化/容器化)。
  return envType ? ENVIRONMENT_FORM_TEXT[envType] : "形态未填";
}

/** 绑定比对与后端工具层门禁同一把尺(repositoryIdentity):trim/去尾
 * 斜杠/去 .git/小写——模块目录里的地址与登记仓的 .git 尾缀写法可能
 * 有差异,原样字符串比对会漏标。 */
function repoIdentity(value: string): string {
  return value.trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
}

/** 终态口径:与会话域既有判断同尺(MaterialsPane 的 reviewEnabled、
 * 协作流的 ended 都是 archived/canceled/failed 三值,#239 票面的
 * canceled/archived 是其子集)。终态会话整页只读——本票的面板本来
 * 零写口,这道闸是给 #241 编辑器预立的结构位。 */
const TERMINAL_STATUSES = ["archived", "canceled", "failed"] as const;

export function IssueMetaPane({ detail }: { detail: IssueDetail }) {
  // 模块绑定仓集合(团队资产目录按 module_id 解析)。undefined = 还没
  // 取到/取不到/没登记模块——绑定标一律不出,仓清单不依赖它。
  const [boundRepos, setBoundRepos] = useState<readonly string[]>();
  useEffect(() => {
    if (!detail.module_id) return;
    let alive = true;
    getBusinessModules()
      .then((catalog) => {
        if (!alive) return;
        const bound = catalog.modules.find(
          (module) => module.id === detail.module_id,
        )?.repositories ?? [];
        setBoundRepos(bound);
      })
      .catch(() => {
        // 目录读不到:绑定标降级缺席,仓清单照列,不给会话页添堵。
        if (alive) setBoundRepos([]);
      });
    return () => { alive = false; };
  }, [detail.module_id]);

  // 全部关联仓:repo_urls 为骨架(彼此平等),repo_url 是单仓旧形状的
  // 兼容位(与逐仓交付 repoDeliveryRows 同一条取数口径)。
  const repos = detail.repo_urls?.length
    ? detail.repo_urls
    : detail.repo_url ? [detail.repo_url] : [];
  const isTerminal =
    (TERMINAL_STATUSES as readonly string[]).includes(detail.status);

  return <div className="grid min-h-0 flex-1 content-start gap-3.5 overflow-y-auto">
    {/* 登记信息区(只读):发起时登记的四项事实。 */}
    <section aria-label="登记信息"
      className="grid content-start gap-2.5 rounded-xl border border-border bg-surface px-3.5 py-3">
      <strong className="text-sm font-bold">登记信息</strong>
      <MetaField label="标题">{detail.title}</MetaField>
      <MetaField label="问题描述">
        <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">
          {detail.description || UNFILLED}
        </span>
      </MetaField>
      <MetaField label="业务模块">{detail.module || UNFILLED}</MetaField>
      <MetaField label="网管环境">
        {detail.environment
          ? <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span>{detail.environment.name}</span>
              <span className="font-mono text-[13px]">
                {detail.environment.hosts.join("、") || UNFILLED}
              </span>
              <span>端口 {detail.environment.port}</span>
              <span>{envTypeText(detail.environment.env_type)}</span>
            </span>
          : UNFILLED}
      </MetaField>
    </section>
    {/* 关联仓清单区(只读):全部登记仓,仓名 + 完整 URL;模块绑定仓
        带标识;现场已回收时如实标注(回收时刻一并示人)。 */}
    <section aria-label="关联仓清单"
      className="grid content-start gap-2 rounded-xl border border-border bg-surface px-3.5 py-3">
      <div className="flex flex-wrap items-baseline gap-2.5">
        <strong className="text-sm font-bold">关联仓清单</strong>
        <span className="text-xs text-faint">发起时登记的全部代码仓,一仓一行</span>
      </div>
      {detail.repo_reclaimed_at && <div className="utility-note" role="status">
        现场已回收({formatLocalDateTime(detail.repo_reclaimed_at)}):
        取消/归档的问题单不再保留 repo 克隆(磁盘纪律),源码可随时重新拉取。
      </div>}
      {repos.length === 0
        ? <Empty className="border py-4.5">
            <EmptyDescription>会话没有登记代码仓——发起时登记的业务模块决定关联仓。</EmptyDescription>
          </Empty>
        : <ul className="m-0 grid list-none content-start gap-2 p-0">
            {repos.map((url) => {
              const bound = (boundRepos ?? [])
                .some((item) => repoIdentity(item) === repoIdentity(url));
              return <li key={url}
                className="grid content-start gap-0.5 rounded-lg border border-line bg-(--surface-muted) px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <strong title={url}
                    className="font-mono text-[13px] font-semibold text-text-strong [overflow-wrap:anywhere]">
                    {repoName(url)}
                  </strong>
                  {bound && <Badge variant="neutral"
                    title="该仓在业务模块的绑定仓清单里(团队资产目录)">模块绑定</Badge>}
                </div>
                <span className="select-text font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {url}
                </span>
              </li>;
            })}
          </ul>}
    </section>
    {/* #241 编辑区挂载点:登记信息的编辑器将来挂这里。终态闸门先立好
        ——终态会话(canceled/archived 等)整页只读,编辑器来了也进不了
        终态会话;本票挂载点为空,零写口。 */}
    {!isTerminal && null}
  </div>;
}

/** 登记信息的一行:标签在上、值在下(只读陈列,无输入控件)。 */
function MetaField({ label, children }: {
  label: string;
  children: ReactNode;
}) {
  return <div className="grid content-start gap-0.5 text-sm">
    <span className="text-xs font-semibold text-muted-foreground">{label}</span>
    <div className="leading-[1.6] text-text-strong">{children}</div>
  </div>;
}

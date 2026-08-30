/**
 * 根错误边界:一次渲染异常不许把整个页面端了,更不许不留证据。
 *
 * 踩过的坑(2026-08-29):知识清单里点某一行就白屏。React 未捕获的渲染
 * 异常会卸载整棵树,页面变纯白——没有报错、没有堆栈、没有可点的东西,
 * 用户只能说"卡死了",排障得靠他自己去翻 F12。全仓当时只有
 * LaunchWorkspace 里一个局部边界,它管不到别处。
 *
 * 这里只做两件事:把页面稳住(还能刷新、还能看见自己在哪),把真相摆出来
 * (错误原文 + 组件栈,可一键复制)。它不替任何人"修复"异常,也不重试——
 * 掩盖一次渲染错误比白屏更坏。
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface RootErrorState {
  error?: Error;
  componentStack?: string;
}

export class RootErrorBoundary extends Component<
  { children: ReactNode }, RootErrorState
> {
  state: RootErrorState = {};

  static getDerivedStateFromError(error: Error): RootErrorState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 控制台仍要留一份:开发者习惯先看 F12,别逼他从页面上抄。
    console.error("[app] 页面渲染失败", error, info);
    this.setState({ componentStack: info.componentStack ?? undefined });
  }

  private report(): string {
    const { error, componentStack } = this.state;
    return [
      `错误:${error?.name ?? "Error"}: ${error?.message ?? "未知错误"}`,
      error?.stack ? `\n调用栈:\n${error.stack}` : "",
      componentStack ? `\n组件栈:${componentStack}` : "",
      `\n页面:${location.pathname}${location.search}`,
      `时间:${new Date().toISOString()}`,
    ].filter(Boolean).join("\n");
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <div className="root-error-screen" role="alert">
      <div className="root-error-card">
        <span className="section-kicker">PAGE ERROR</span>
        <h1>页面出错了，不是你的操作有问题</h1>
        <p>
          界面某一处渲染失败。你的数据没有丢——服务端状态不受影响，
          刷新后可以继续。下面是给排查用的原文，请连同「你刚点了什么」
          一起反馈。
        </p>
        <pre className="root-error-detail">{this.report()}</pre>
        <div className="root-error-actions">
          <button type="button" onClick={() => location.reload()}>
            刷新页面
          </button>
          <button type="button" onClick={() => {
            // 内网 http 下 clipboard API 可能不可用;失败就让用户手选,
            // 不弹错误盖住正文。
            void navigator.clipboard?.writeText(this.report()).catch(
              () => undefined);
          }}>复制错误详情</button>
        </div>
      </div>
    </div>;
  }
}

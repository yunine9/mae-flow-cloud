import { createRoot } from "react-dom/client";
import { App } from "./App";
import { RootErrorBoundary } from "./RootErrorBoundary";
import "./style.css";
// 错误页样式单独一个文件,不并进 style.css:那是全站共享的热点文件,
// 几路改动同时往文件尾追加会互相踩(实测撞过一次)。样式在这里引,
// 不在组件里引——组件要能被 node 测试直接 import,而 node 加载不了 .css。
import "./rootError.css";

// 主题:URL 仅用于截图/核查;日常选择持久化。第一次访问才跟随系统，
// 之后由用户明确选择，避免刷新时在明暗之间闪烁。
const queryTheme = new URLSearchParams(location.search).get("theme");
let savedTheme: string | null = null;
try { savedTheme = localStorage.getItem("mae-flow-theme"); } catch { /* 私密模式也能用 */ }
const theme = queryTheme === "light" || queryTheme === "dark"
  ? queryTheme
  : savedTheme === "light" || savedTheme === "dark"
    ? savedTheme
    : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
document.documentElement.dataset.theme = theme;

let savedDensity: string | null = null;
try { savedDensity = localStorage.getItem("mae-flow-density"); } catch { /* 私密模式也能用 */ }
document.documentElement.dataset.density = savedDensity === "compact" ? "compact" : "comfortable";

// 兜住整棵树:渲染异常显示可读的错误页,而不是把页面清空(见
// RootErrorBoundary 头注释里那次"点一行就白屏"的实测)。
createRoot(document.getElementById("root")!).render(
  <RootErrorBoundary><App /></RootErrorBoundary>);

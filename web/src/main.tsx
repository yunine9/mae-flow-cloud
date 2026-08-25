import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./style.css";

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

createRoot(document.getElementById("root")!).render(<App />);

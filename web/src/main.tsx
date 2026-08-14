import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./style.css";

// 主题:默认跟随系统;?theme=light|dark 强制指定(截图核查与
// 手动切换共用这条路,落在 :root[data-theme] 上)。
const theme = new URLSearchParams(location.search).get("theme");
if (theme === "light" || theme === "dark") {
  document.documentElement.dataset.theme = theme;
}

createRoot(document.getElementById("root")!).render(<App />);

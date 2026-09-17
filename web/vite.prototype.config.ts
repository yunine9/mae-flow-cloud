/**
 * 【原型·随时可扔】仅按特性分类原型验收用:把 API 代理指到 8839 的
 * 样本服务(.prototype-issue-fixtures)。用法:
 *   npx vite --config vite.prototype.config.ts --port 5180
 * 其余与正式 vite.config.ts 完全一致(插件/别名不动,只换代理目标)。
 */
import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const target = "http://127.0.0.1:8839";

const apiPrefixes = [
  "/auth", "/tasks", "/skills", "/settings", "/business-modules",
  "/wishes", "/environments", "/issues", "/workflow-assets", "/knowledge",
  "/knowledge-candidates", "/knowledge-insights", "/delivery-analytics",
  "/launch-knowledge-preview", "/launch-options", "/memory-insights",
  "/repositories", "/repository-profiles", "/repository-resource-policy",
  "/repository-skills", "/requirement-bundles", "/reviews", "/diagrams",
  "/history", "/build-info",
];

function isBrowserNavigation(url = "", accept = ""): boolean {
  if (!accept.includes("text/html")) return false;
  const path = url.split("?")[0]!.replace(/\/$/, "");
  return path === "/environments" || path === "/issues"
    || /^\/issues\/[^/]+$/.test(path);
}

function proxy(): Record<string, ProxyOptions> {
  const entries: Record<string, ProxyOptions> = {};
  for (const prefix of apiPrefixes) {
    entries[prefix] = {
      target,
      changeOrigin: true,
      bypass: (request) => {
        if (prefix !== "/issues" && prefix !== "/environments") return;
        if (isBrowserNavigation(request.url,
          String(request.headers.accept ?? ""))) {
          return request.url;
        }
      },
    };
  }
  return entries;
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  server: {
    proxy: proxy(),
  },
});

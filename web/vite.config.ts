import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 开发态把任务 API 代理到本地服务(npm run serve, 8787):
// 前端永远只说 /tasks,部署时由同源反代兜住,代码里不写死地址。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // @ 别名(shadcn 约定,components.json 同步):用 URL 推路径,免引 node 类型。
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  server: {
    proxy: {
      "/tasks": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
});

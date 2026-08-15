/** 一次性核对用:把真实 story.md 的类图用真组件渲成静态 HTML,截图看眼睛看到的是什么。 */
import { readFileSync, writeFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseClassDiagram } from "./src/classModel.ts";
import { ClassDiagram, ClassDiagramLegend } from "./src/ClassDiagram.tsx";

const story = readFileSync(process.argv[2], "utf8");
const src = story.split("```plantuml")[1].split("```")[0];
const model = parseClassDiagram(src);
if (!model) throw new Error("解析不出类图");

const read = (name: string) =>
  readFileSync(new URL(`./src/${name}`, import.meta.url), "utf8");
const html = `<!doctype html><meta charset="utf-8"><style>
${read("style.css")}
${read("annotate.css")}
body{background:var(--surface);margin:0;padding:16px}
</style>${renderToStaticMarkup(
  <div>
    <ClassDiagramLegend />
    <ClassDiagram model={model} />
  </div>,
)}`;
writeFileSync(process.argv[3], html);
console.log("节点", model.nodes.length, "边", model.edges.length);

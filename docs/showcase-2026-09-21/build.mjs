import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(dir, '../..');
const temp = mkdtempSync(join(tmpdir(), 'mae-showcase-'));
const sources = { overview: 'mae-flow.architecture.json', delivery: 'delivery.architecture.json', knowledge: 'knowledge.architecture.json' };
const filenames = { overview: 'architecture.svg', delivery: 'delivery.svg', knowledge: 'knowledge.svg' };
try {
  const css = readFileSync(join(dir, 'presentation.css'), 'utf8');
  const graphs = {}, diagrams = {};
  for (const [view, source] of Object.entries(sources)) {
    const output = join(temp, `${view}.html`);
    graphs[view] = JSON.parse(readFileSync(join(dir, source), 'utf8'));
    execFileSync(process.execPath, [join(root, 'vendor/archify/renderers/architecture/render-architecture.mjs'), join(dir, source), output], {
      cwd: root, env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', ARCHIFY_UPDATE_CHECK_DISABLED: '1' }, stdio: 'inherit',
    });
    const native = readFileSync(output, 'utf8');
    let svg = native.match(/<svg viewBox="0 0 [\d.]+ [\d.]+"[\s\S]*?<\/svg>/)?.[0];
    if (!svg) throw new Error(`Archify 未输出 ${view} 架构图`);
    const knowledge = new Set(graphs[view].components.filter(n => n.type === 'backend').map(n => n.id));
    svg = svg.replace('role="img"', 'role="group"').replace(/<(?:g|path)\b[^>]*>/g, tag => {
      const node = tag.match(/data-node-id="([^"]+)"/)?.[1];
      const from = tag.match(/data-edge-from="([^"]+)"/)?.[1];
      const to = tag.match(/data-edge-to="([^"]+)"/)?.[1];
      const cls = node === 'k_business' ? 'knowledge-node planned-node' : knowledge.has(node) ? 'knowledge-node' : knowledge.has(from) || knowledge.has(to) ? 'knowledge-edge' : '';
      if (!cls) return tag;
      return /class="/.test(tag) ? tag.replace('class="', `class="${cls} `) : tag.replace(/>$/, ` class="${cls}">`);
    }).replace('</defs>', '<marker id="knowledge-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#62dcc0"/></marker></defs>');
    diagrams[view] = svg;
    writeFileSync(join(dir, filenames[view]), svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ').replace(/(<svg[^>]*>)/, `$1<style>${css}</style><rect width="100%" height="100%" fill="#081322"/>`));
  }
  const details = JSON.parse(readFileSync(join(dir, 'module-details.json'), 'utf8'));
  for (const graph of Object.values(graphs)) for (const node of graph.components) {
    if (!details[node.id]?.[0]) throw new Error(`缺少模块职责：${node.id}`);
  }
  const data = { graphs, details, filenames };
  const html = readFileSync(join(dir, 'presentation.template.html'), 'utf8')
    .replace('<!-- STYLES -->', `<style id="presentation-style">${css}</style>`)
    .replace('<!-- ARCHIFY -->', diagrams.overview)
    .replace('<!-- LOGIC -->', Object.entries(diagrams).map(([id, svg]) => `<template id="view-${id}">${svg}</template>`).join('')
      + `<script type="application/json" id="graph-data">${JSON.stringify(data).replaceAll('<', '\\u003c')}</script><script>${readFileSync(join(dir, 'presentation.js'), 'utf8')}</script>`);
  writeFileSync(join(dir, 'index.html'), html);
  const publicDir = join(root, 'web/public/help/platform-overview');
  mkdirSync(publicDir, { recursive: true });
  for (const file of ['index.html', ...Object.values(filenames)]) copyFileSync(join(dir, file), join(publicDir, file));
  console.log('Built 3 Archify views: ' + join(dir, 'index.html'));
} finally { rmSync(temp, { recursive: true, force: true }); }

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(dir, '../..');
const temp = mkdtempSync(join(tmpdir(), 'mae-showcase-'));
try {
  const output = join(temp, 'native.html');
  execFileSync(process.execPath, [join(root, 'vendor/archify/renderers/architecture/render-architecture.mjs'), join(dir, 'mae-flow.architecture.json'), output], {
    cwd: root, env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', ARCHIFY_UPDATE_CHECK_DISABLED: '1' }, stdio: 'inherit',
  });
  const native = readFileSync(output, 'utf8');
  let svg = native.match(/<svg viewBox="0 0 [\d.]+ [\d.]+"[\s\S]*?<\/svg>/)?.[0];
  if (!svg) throw new Error('Archify 未输出主架构图');
  const knowledge = new Set(['extract', 'search', 'assets', 'adopt', 'organize', 'retrospect']);
  svg = svg.replace('role="img"', 'role="group"').replace(/<(?:g|path)\b[^>]*>/g, tag => {
    const node = tag.match(/data-node-id="([^"]+)"/)?.[1];
    const from = tag.match(/data-edge-from="([^"]+)"/)?.[1];
    const to = tag.match(/data-edge-to="([^"]+)"/)?.[1];
    const cls = knowledge.has(node) ? 'knowledge-node' : knowledge.has(from) || knowledge.has(to) ? 'knowledge-edge' : '';
    if (!cls) return tag;
    return /class="/.test(tag) ? tag.replace('class="', `class="${cls} `) : tag.replace(/>$/, ` class="${cls}">`);
  }).replace('</defs>', '<marker id="knowledge-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#62dcc0"/></marker></defs>');
  const template = readFileSync(join(dir, 'presentation.template.html'), 'utf8');
  const css = readFileSync(join(dir, 'presentation.css'), 'utf8');
  const script = readFileSync(join(dir, 'presentation.js'), 'utf8');
  const graph = JSON.parse(readFileSync(join(dir, 'mae-flow.architecture.json'), 'utf8'));
  const html = template.replace('<!-- STYLES -->', `<style id="presentation-style">${css}</style>`)
    .replace('<!-- ARCHIFY -->', svg)
    .replace('<!-- LOGIC -->', `<script type="application/json" id="graph-data">${JSON.stringify(graph).replaceAll('<', '\\u003c')}</script><script>${script}</script>`);
  writeFileSync(join(dir, 'index.html'), html);
  writeFileSync(join(dir, 'architecture.svg'), svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ').replace(/(<svg[^>]*>)/, `$1<style>${css}</style><rect width="100%" height="100%" fill="#081322"/>`));
  // 随正常 web build 发布，同一份源同时生成离线材料与平台帮助资产。
  const publicDir = join(root, 'web/public/help/platform-overview');
  mkdirSync(publicDir, { recursive: true });
  for (const file of ['index.html', 'architecture.svg']) copyFileSync(join(dir, file), join(publicDir, file));
  console.log('Built Archify showcase: ' + join(dir, 'index.html'));
} finally { rmSync(temp, { recursive: true, force: true }); }

// mod-agent 文档本地阅读服务
// 用法：npm run docs
// - 每次请求实时扫描 docs/*.md，新增/删除文档自动出现在菜单
// - 文档顺序：md 顶部可写 `--- order: 5 ---`，未写则按内置 fallback
const http = require('http');
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const LAYOUT = fs.readFileSync(path.join(DOCS, '_layout.html'), 'utf8');
const PORT = process.env.PORT || 4321;

// 内置顺序（未在 frontmatter 指定 order 的文档按此表排）
const FALLBACK_ORDER = [
  'README', 'overview', 'research', 'architecture', 'agent-loop',
  'context-engineering', 'tools-and-extensions', 'code-editing',
  'verification-and-multiagent', 'security', 'data-and-events',
  'model-gateway', 'observability-evaluation', 'roadmap', 'references',
];

function scanDocs() {
  return fs.readdirSync(DOCS)
    .filter(f => f.endsWith('.md') && !f.startsWith('_'))
    .map(f => {
      const name = f.replace(/\.md$/, '');
      const text = fs.readFileSync(path.join(DOCS, f), 'utf8').replace(/^\uFEFF/, '');
      const fm = text.match(/^---\s*\n([\s\S]*?)\n---/);
      let order = FALLBACK_ORDER.indexOf(name);
      if (fm) {
        const m = fm[1].match(/order\s*:\s*(\d+)/);
        if (m) order = parseInt(m[1], 10) - 1;
      }
      const title = text.match(/^#\s+(.+)$/m)?.[1] || name;
      const body = fm ? text.slice(fm[0].length) : text;
      return { name, title, body, order: order === -1 ? 999 : order };
    })
    .sort((a, b) => a.order - b.order);
}

function page(doc, all) {
  const i = all.findIndex(d => d.name === doc.name);
  const prev = all[i - 1];
  const next = all[i + 1];
  const nav = all.map((d, n) =>
    `<a href="/doc/${d.name}" class="${d.name === doc.name ? 'active' : ''}">` +
    `<span class="num">${String(n + 1).padStart(2, '0')}</span>${d.title}</a>`).join('');
  const bodyHtml = marked.parse(doc.body, { gfm: true })
    .replace(/href="\.\/([a-z-]+)\.md"/g, 'href="/doc/$1"');
  return LAYOUT
    .replace('{{TITLE}}', doc.title)
    .replace('{{NAV}}', nav)
    .replace('{{CONTENT}}', bodyHtml)
    .replace('{{PREV_HTML}}', prev ? `<a href="/doc/${prev.name}">← ${prev.title}</a>` : '<span class="placeholder"></span>')
    .replace('{{NEXT_HTML}}', next ? `<a href="/doc/${next.name}">${next.title} →</a>` : '<span class="placeholder"></span>');
}

function start(port) {
  http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const file = (p, type) => fs.readFile(path.join(ROOT, p), (e, d) =>
      e ? (res.writeHead(404), res.end()) : (res.writeHead(200, { 'Content-Type': type }), res.end(d)));

    if (url.pathname === '/marked.min.js') return file('node_modules/marked/marked.min.js', 'application/javascript');
    if (url.pathname === '/mermaid.min.js') return file('node_modules/mermaid/dist/mermaid.min.js', 'application/javascript');

    const all = scanDocs();
    let name = url.pathname === '/' ? 'README' : url.pathname.startsWith('/doc/') ? decodeURIComponent(url.pathname.slice(5)) : null;
    const doc = all.find(d => d.name === name) || all[0];
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page(doc, all));
  }).on('error', (e) => {
    if (e.code === 'EADDRINUSE') { console.warn(`端口 ${port} 被占用，尝试 ${port + 1} ...`); start(port + 1); }
    else throw e;
  }).listen(port, () => console.log(`docs running at http://localhost:${port}`));
}

start(PORT);

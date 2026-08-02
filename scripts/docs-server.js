// mod-agent 文档本地阅读服务
// 用法：npm run docs  →  打开 http://localhost:4321
// 不依赖外网 CDN，前端库直接从 node_modules 读。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

const ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(ROOT, 'docs');
const PORT = process.env.PORT || 4321;

// 文档阅读顺序：README 作首页，其余按设计逻辑排列
const ORDER = [
  'README',
  'overview',
  'research',
  'architecture',
  'agent-loop',
  'context-engineering',
  'tools-and-extensions',
  'code-editing',
  'verification-and-multiagent',
  'security',
  'data-and-events',
  'model-gateway',
  'observability-evaluation',
  'roadmap',
  'references',
];

// 收集文档元信息
const docs = fs.readdirSync(DOCS_DIR)
  .filter(f => f.endsWith('.md'))
  .map(f => {
    const name = f.replace(/\.md$/, '');
    const title = fs.readFileSync(path.join(DOCS_DIR, f), 'utf8')
      .match(/^#\s+(.+)$/m)?.[1] || name;
    return { name, title, file: f };
  })
  .sort((a, b) => {
    const ia = ORDER.indexOf(a.name);
    const ib = ORDER.indexOf(b.name);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

// md 内相对链接 ./xxx.md 重写为 /doc/xxx
function renderMd(md) {
  const html = marked.parse(md, { gfm: true });
  return html.replace(/href="\.\/([a-z-]+)\.md"/g, 'href="/doc/$1"');
}

function layout({ active, bodyHtml }) {
  const idx = docs.findIndex(d => d.name === active);
  const prev = docs[idx - 1];
  const next = docs[idx + 1];
  const nav = docs.map(d => `
    <a href="/doc/${d.name}" class="${d.name === active ? 'active' : ''}">
      <span class="num">${String(docs.indexOf(d) + 1).padStart(2, '0')}</span>${d.title}
    </a>`).join('');
  const pager = `
    <div class="pager">
      ${prev ? `<a class="prev" href="/doc/${prev.name}">← ${prev.title}</a>` : '<span></span>'}
      ${next ? `<a class="next" href="/doc/${next.name}">${next.title} →</a>` : '<span></span>'}
    </div>`;
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${docs[idx]?.title || 'docs'} · mod-agent</title>
<style>
  :root { --bg:#f7f6f3; --ink:#1f2328; --muted:#6b7280; --side:#111827; --side-ink:#e5e7eb; --accent:#2563eb; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.7 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; color:var(--ink); background:var(--bg); }
  .wrap { display:flex; min-height:100vh; }
  aside { width:280px; flex-shrink:0; background:var(--side); color:var(--side-ink); padding:24px 0; position:sticky; top:0; height:100vh; overflow:auto; }
  aside .brand { padding:0 24px 16px; font-weight:700; letter-spacing:.5px; color:#fff; }
  aside a { display:flex; gap:10px; padding:9px 24px; color:#cbd5e1; text-decoration:none; font-size:13.5px; border-left:3px solid transparent; }
  aside a:hover { background:#1f2937; }
  aside a.active { background:#1f2937; border-left-color:var(--accent); color:#fff; }
  aside a .num { color:#6b7280; font-variant-numeric:tabular-nums; }
  main { flex:1; max-width:860px; padding:48px 56px 80px; }
  main h1 { font-size:28px; margin-top:0; }
  main h2 { margin-top:36px; padding-bottom:6px; border-bottom:1px solid #e5e7eb; }
  main code { background:#eef0f3; padding:2px 6px; border-radius:4px; font-size:13px; font-family:ui-monospace,Consolas,monospace; }
  main pre { background:#0f172a; color:#e2e8f0; padding:16px 18px; border-radius:8px; overflow:auto; font-size:13px; line-height:1.55; }
  main pre code { background:transparent; padding:0; color:inherit; }
  main blockquote { margin:16px 0; padding:8px 16px; border-left:4px solid var(--accent); background:#eff6ff; color:#1e40af; }
  main table { border-collapse:collapse; width:100%; margin:16px 0; }
  main th, main td { border:1px solid #e5e7eb; padding:8px 12px; text-align:left; }
  main th { background:#f3f4f6; }
  main img { max-width:100%; }
  .pager { display:flex; justify-content:space-between; margin-top:56px; padding-top:20px; border-top:1px solid #e5e7eb; }
  .pager a { color:var(--accent); text-decoration:none; font-weight:500; }
  .pager a:hover { text-decoration:underline; }
  .mermaid { background:#fff; text-align:center; margin:16px 0; }
  @media (max-width:800px) {
    .wrap { flex-direction:column; }
    aside { width:100%; height:auto; position:static; }
    main { padding:24px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <aside>
    <div class="brand">mod-agent</div>
    <nav>${nav}</nav>
  </aside>
  <main>${bodyHtml}${pager}</main>
</div>
<script src="/marked.min.js"></script>
<script src="/mermaid.min.js"></script>
<script>
  if (window.mermaid) mermaid.initialize({ startOnLoad:true, theme:'neutral', securityLevel:'loose' });
</script>
</body>
</html>`;
}

function send(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function listen(port) {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    // 前端库：直接从 node_modules 读
    if (url.pathname === '/marked.min.js') {
      return fs.readFile(path.join(ROOT, 'node_modules/marked/marked.min.js'), (e, d) =>
        e ? send(res, 404, 'not found', 'text/plain') : send(res, 200, d, 'application/javascript'));
    }
    if (url.pathname === '/mermaid.min.js') {
      return fs.readFile(path.join(ROOT, 'node_modules/mermaid/dist/mermaid.min.js'), (e, d) =>
        e ? send(res, 404, 'not found', 'text/plain') : send(res, 200, d, 'application/javascript'));
    }

    // 文档路由
    let name = null;
    if (url.pathname === '/' || url.pathname === '/index.html') name = 'README';
    else if (url.pathname.startsWith('/doc/')) name = decodeURIComponent(url.pathname.slice(5));

    const doc = docs.find(d => d.name === name);
    if (!doc) return send(res, 404, layout({ active: 'README', bodyHtml: '<h1>404</h1><p>未找到文档。</p>' }));

    const md = fs.readFileSync(path.join(DOCS_DIR, doc.file), 'utf8');
    send(res, 200, layout({ active: doc.name, bodyHtml: renderMd(md) }));
  });

  srv.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.warn(`[docs] 端口 ${port} 被占用，尝试 ${port + 1} ...`);
      listen(port + 1);
    } else {
      throw e;
    }
  });
  srv.listen(port, () => console.log(`docs running at http://localhost:${port}`));
}

listen(PORT);

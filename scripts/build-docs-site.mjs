// Builds the standalone user-manual site for docs.modelswap.app from
// docs/manual/{zh,en}/*.md. Output: docs-site-dist/ (gitignored).
//
// Usage: node scripts/build-docs-site.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'docs', 'manual');
const OUT = path.join(ROOT, 'docs-site-dist');

const LANGS = { zh: '中文', en: 'English' };
const TITLES = { zh: 'ModelSwap 用户手册', en: 'ModelSwap User Manual' };

function chapters(lang) {
  const dir = path.join(SRC, lang);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  return files.map((file) => {
    const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
    const h1 = (raw.match(/^#\s+(.+)$/m) || [, file])[1].replace(/^\d+\.\d*\s*/, '');
    const slug = file.replace(/\.md$/, '');
    return { file, slug, title: h1, raw };
  });
}

// Rewrite relative md links to extensionless pretty URLs (Cloudflare Workers
// assets normalize /x.html -> /x with a 307; linking directly avoids the hop).
function rewrite(html) {
  return html
    .replace(/href="([^"]*)\.md"/g, 'href="$1"')
    .replace(/(src=")(\.\.\/)?images\//g, '$1images/');
}

const CSS = `
:root{--paper:#fefcf8;--paper2:#f5ebe0;--ink:#1c1917;--muted:#a8a29e;--line:#e7ddd0;--accent:#e8622d}
*{box-sizing:border-box}body{margin:0;font:16px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB",sans-serif;color:var(--ink);background:var(--paper)}
a{color:inherit;text-decoration:none}a:hover{color:var(--accent)}
header{position:sticky;top:0;z-index:9;display:flex;align-items:center;gap:12px;padding:12px 24px;background:rgba(254,252,248,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
header img{width:28px;height:28px;border-radius:7px}
header b{font-size:15px}
header .lang{margin-left:auto;font-size:13px;color:var(--muted)}
header .lang a{padding:4px 8px;border-radius:6px}header .lang a.on{background:var(--paper2);color:var(--ink)}
.wrap{display:flex;max-width:1180px;margin:0 auto;padding:0 24px}
nav{width:250px;flex:none;padding:28px 16px 64px;position:sticky;top:57px;height:calc(100vh - 57px);overflow:auto;border-right:1px solid var(--line)}
nav a{display:block;padding:6px 12px;border-radius:8px;font-size:14px;color:#57534e}
nav a:hover{background:var(--paper2)}nav a.on{background:var(--paper2);color:var(--ink);font-weight:600}
main{flex:1;min-width:0;padding:36px 40px 96px;max-width:820px}
main h1{font-size:30px;line-height:1.3;margin:0 0 8px}
main h1::after{content:"";display:block;width:56px;height:4px;border-radius:2px;background:var(--accent);margin-top:14px}
main h2{font-size:22px;margin-top:44px}
main h3{font-size:17px;margin-top:32px}
main img{max-width:100%;border:1px solid var(--line);border-radius:12px;box-shadow:2px 2px 0 rgba(28,25,23,.06);margin:8px 0}
main code{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:13.5px;background:var(--paper2);padding:2px 6px;border-radius:5px}
main pre{background:#1c1917;color:#ede6dc;padding:18px 20px;border-radius:12px;overflow:auto}main pre code{background:none;color:inherit;padding:0}
main table{border-collapse:collapse;width:100%;font-size:14px}main th,main td{border:1px solid var(--line);padding:8px 12px;text-align:left}main th{background:var(--paper2)}
main blockquote{margin:0;padding:10px 18px;border-left:4px solid var(--paper2);background:var(--paper);border-radius:0 10px 10px 0}
.pager{display:flex;justify-content:space-between;margin-top:64px;padding-top:20px;border-top:1px dashed var(--line);font-size:14px}
.pager a{color:var(--accent)}
@media(max-width:900px){nav{display:none}main{padding:24px 4px 80px}}
`;

function page({ lang, chapter, all, index }) {
  const body = rewrite(marked.parse(chapter.raw, { async: false }));
  const prev = all[index - 1], next = all[index + 1];
  const nav = all
    .map((c) => `<a href="${c.slug}"${c === chapter ? ' class="on"' : ''}>${c.title}</a>`)
    .join('');
  const other = lang === 'zh' ? 'en' : 'zh';
  return `<!DOCTYPE html><html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${chapter.title} · ${TITLES[lang]}</title>
<meta name="description" content="${TITLES[lang]} — ModelSwap">
<link rel="icon" href="https://modelswap.app/assets/favicon.png">
<link rel="stylesheet" href="/style.css"></head><body>
<header>
  <a href="https://modelswap.app/"><img src="https://modelswap.app/assets/branding/modelswap-icon.png" alt="ModelSwap"></a>
  <b>ModelSwap ${lang === 'zh' ? '用户手册' : 'User Manual'}</b>
  <span class="lang"><a href="/${lang}/" class="on">${LANGS[lang]}</a><a href="/${other}/">${LANGS[other]}</a></span>
</header>
<div class="wrap">
<nav>${nav}</nav>
<main>
${body}
<div class="pager">${prev ? `<a href="${prev.slug}">← ${prev.title}</a>` : '<span></span>'}${next ? `<a href="${next.slug}">${next.title} →</a>` : ''}</div>
</main></div></body></html>`;
}

fs.rmSync(OUT, { recursive: true, force: true });
for (const lang of Object.keys(LANGS)) {
  const all = chapters(lang);
  fs.mkdirSync(path.join(OUT, lang), { recursive: true });
  all.forEach((chapter, index) => {
    fs.writeFileSync(path.join(OUT, lang, chapter.slug + '.html'), page({ lang, chapter, all, index }));
  });
  // images are shared (../images/) → copy once per lang dir
  fs.cpSync(path.join(SRC, 'images'), path.join(OUT, lang, 'images'), { recursive: true });
  // /zh/ index → first chapter
  fs.writeFileSync(path.join(OUT, lang, 'index.html'), `<meta http-equiv="refresh" content="0;url=${all[0].slug}">`);
}
fs.writeFileSync(path.join(OUT, 'style.css'), CSS);
fs.writeFileSync(path.join(OUT, 'index.html'), `<meta http-equiv="refresh" content="0;url=/zh/">`);
console.log('docs site built →', OUT);

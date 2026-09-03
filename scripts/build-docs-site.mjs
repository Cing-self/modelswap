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
:root{
  --canvas:#0b0b09; --cream:#f4f1e8; --cream-60:rgba(244,241,232,.62); --cream-38:rgba(244,241,232,.38);
  --hairline:rgba(244,241,232,.14); --panel:rgba(244,241,232,.045); --panel-2:rgba(244,241,232,.08);
  --lime:#c6ff3e; --lime-deep:#a4d92b;
  --serif:"Fraunces","Songti SC","Noto Serif SC",Georgia,serif;
  --sans:"Inter","PingFang SC","Microsoft YaHei",-apple-system,sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,"SF Mono",monospace;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;font:16px/1.78 var(--sans);color:var(--cream);background:var(--canvas);-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}a:hover{color:var(--lime)}
::selection{background:var(--lime);color:var(--canvas)}
header{position:sticky;top:0;z-index:9;display:flex;align-items:center;gap:12px;padding:14px 28px;background:rgba(11,11,9,.9);backdrop-filter:blur(10px);border-bottom:1px solid var(--hairline)}
header img{width:28px;height:28px;border-radius:7px}
header b{font:600 16px var(--serif);letter-spacing:.02em}
header .lang{margin-left:auto;font-size:13px;color:var(--cream-38)}
header .lang a{padding:4px 9px;border-radius:6px}header .lang a.on{background:var(--panel-2);color:var(--cream)}
.wrap{display:flex;max-width:1180px;margin:0 auto;padding:0 28px}
nav{width:256px;flex:none;padding:30px 14px 72px;position:sticky;top:61px;height:calc(100vh - 61px);overflow:auto;border-right:1px solid var(--hairline)}
nav a{display:block;padding:6px 12px;border-radius:8px;font-size:13.5px;color:var(--cream-60)}
nav a:hover{background:var(--panel);color:var(--cream)}
nav a.on{background:var(--panel-2);color:var(--lime);font-weight:600}
main{flex:1;min-width:0;padding:44px 44px 110px;max-width:820px}
main h1{font:600 34px/1.25 var(--serif);margin:0 0 10px}
main h1::after{content:"";display:block;width:56px;height:3px;border-radius:2px;background:var(--lime);margin-top:16px}
main h2{font:600 23px/1.35 var(--serif);margin-top:48px}
main h3{font:600 16.5px var(--sans);margin-top:34px;color:var(--cream)}
main p,main li{color:var(--cream-60)}main p{margin:14px 0}
main strong{color:var(--cream);font-weight:600}
main img{max-width:100%;border:1px solid var(--hairline);border-radius:12px;margin:10px 0;background:#000}
main code{font:13.5px var(--mono);background:var(--panel-2);color:var(--cream);padding:2px 7px;border-radius:5px}
main pre{background:var(--panel);border:1px solid var(--hairline);color:var(--cream);padding:18px 20px;border-radius:12px;overflow:auto}
main pre code{background:none;color:inherit;padding:0}
main table{border-collapse:collapse;width:100%;font-size:14px}
main th,main td{border:1px solid var(--hairline);padding:9px 13px;text-align:left}
main th{background:var(--panel);color:var(--cream);font-weight:600}main td{color:var(--cream-60)}
main blockquote{margin:0;padding:12px 18px;border-left:3px solid var(--lime-deep);background:var(--panel);border-radius:0 10px 10px 0}
main blockquote p{color:var(--cream)}
.pager{display:flex;justify-content:space-between;margin-top:70px;padding-top:22px;border-top:1px dashed var(--hairline);font-size:14px}
.pager a{color:var(--lime-deep)}.pager a:hover{color:var(--lime)}
/* 窄屏章节抽屉：<900px 替代侧边栏（纯 details/summary，无 JS） */
.docs-nav-mobile{display:none;margin:18px 0 4px;border:1px solid var(--hairline);border-radius:12px;background:var(--panel);overflow:hidden}
.docs-nav-mobile summary{cursor:pointer;list-style:none;padding:13px 16px;font:600 14px var(--sans);color:var(--cream);display:flex;align-items:center;gap:8px}
.docs-nav-mobile summary::-webkit-details-marker{display:none}
.docs-nav-mobile summary::after{content:"";margin-left:auto;width:9px;height:9px;border-right:2px solid var(--cream-38);border-bottom:2px solid var(--cream-38);transform:rotate(45deg);transition:transform .15s}
.docs-nav-mobile[open] summary::after{transform:rotate(225deg)}
.docs-nav-mobile .docs-nav-list{max-height:58vh;overflow:auto;border-top:1px dashed var(--hairline);padding:8px}
.docs-nav-mobile .docs-nav-list a{display:block;padding:8px 12px;border-radius:8px;font-size:14px;color:var(--cream-60)}
.docs-nav-mobile .docs-nav-list a:hover{background:var(--panel-2)}
.docs-nav-mobile .docs-nav-list a.on{background:var(--panel-2);color:var(--lime);font-weight:600}
@media(max-width:900px){nav{display:none}main{padding:24px 6px 80px}.docs-nav-mobile{display:block}}
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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;1,9..144,500&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css"></head><body>
<header>
  <a href="https://modelswap.app/"><img src="https://modelswap.app/assets/branding/modelswap-icon.png" alt="ModelSwap"></a>
  <b>ModelSwap ${lang === 'zh' ? '用户手册' : 'User Manual'}</b>
  <span class="lang"><a href="/${lang}/" class="on">${LANGS[lang]}</a><a href="/${other}/">${LANGS[other]}</a></span>
</header>
<div class="wrap">
<nav>${nav}</nav>
<main>
<details class="docs-nav-mobile"><summary>☰ ${lang === 'zh' ? '章节目录' : 'Chapters'}</summary><div class="docs-nav-list">${nav}</div></details>
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

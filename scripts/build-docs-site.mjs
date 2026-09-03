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

// Navigation: explicit chapter order & groups — NOT filename sort. The sidebar
// should mirror the reader's journey (install → keys → models → agents → data →
// reference), so adding/removing a chapter means updating NAV here, not naming
// files cleverly. Group labels are per-language.
const NAV = {
  en: [
    { group: 'Getting Started', chapters: ['01-what-is-modelswap', '02-install', '03-quickstart'] },
    { group: 'Key Management', chapters: ['04-extension', '05-auto-create', '06-vault'] },
    { group: 'Models', chapters: ['07-providers', '08-usage'] },
    { group: 'Agents', chapters: ['09-agents', '10-agent-skill'] },
    { group: 'Data & Security', chapters: ['11-sync', '12-snapshots'] },
    { group: 'Reference', chapters: ['13-settings', '14-cli', '15-faq'] },
  ],
  zh: [
    { group: '快速上手', chapters: ['01-what-is-modelswap', '02-install', '03-quickstart'] },
    { group: '密钥管理', chapters: ['04-extension', '05-auto-create', '06-vault'] },
    { group: '模型配置', chapters: ['07-providers', '08-usage'] },
    { group: 'Agent 配置', chapters: ['09-agents', '10-agent-skill'] },
    { group: '数据与安全', chapters: ['11-sync', '12-snapshots'] },
    { group: '参考', chapters: ['13-settings', '14-cli', '15-faq'] },
  ],
};

function chapters(lang) {
  const dir = path.join(SRC, lang);
  // README.md is the GitHub-facing manual index, not a chapter.
  const bySlug = new Map();
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.md') || file === 'README.md') continue;
    const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
    const h1 = (raw.match(/^#\s+(.+)$/m) || [, file])[1].replace(/^\d+\.\d*\s*/, '');
    const slug = file.replace(/\.md$/, '');
    bySlug.set(slug, { file, slug, title: h1, raw });
  }
  // Fail loudly on drift between NAV and the chapter files on disk: a listed
  // chapter that is missing, or a file no longer in NAV, would silently break.
  const listed = NAV[lang].flatMap((g) => g.chapters);
  for (const slug of listed) {
    if (!bySlug.has(slug)) throw new Error(`chapters(): NAV lists "${slug}" but ${lang}/${slug}.md is missing`);
  }
  for (const slug of bySlug.keys()) {
    if (!listed.includes(slug)) throw new Error(`chapters(): ${lang}/${slug}.md exists but is not in NAV`);
  }
  return NAV[lang].map(({ group, chapters: slugs }) => ({
    group,
    chapters: slugs.map((slug) => bySlug.get(slug)),
  }));
}

// Rewrite relative md links to extensionless pretty URLs (Cloudflare Workers
// assets normalize /x.html -> /x with a 307; linking directly avoids the hop).
function rewrite(html) {
  return html
    .replace(/href="([^"]*)\.md"/g, 'href="$1"')
    .replace(/(src=")(\.\.\/)?images\//g, '$1images/');
}

// --- SEO/GEO: per-page meta description + escape helper -----------------
// One-line description: first prose paragraph of the chapter (skip the h1,
// headings, tables, images, list/blockquote openers), markdown stripped.
function metaDescription(raw) {
  const line = raw
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .find((t) => t && !t.startsWith('#') && !t.startsWith('|') && !t.startsWith('![') && !t.startsWith('- ') && !t.startsWith('>'));
  if (!line) return null;
  const text = line
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
  return text.length > 158 ? text.slice(0, 155).replace(/\s+\S*$/, '') + '…' : text;
}

const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
nav .nav-group{margin:22px 0 6px;padding:0 12px;font:600 11px/1 var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--cream-38)}
nav .nav-group:first-child{margin-top:0}
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

function renderNav(groups, currentSlug) {
  return groups
    .map(
      ({ group, chapters }) =>
        `<div class="nav-group">${group}</div>` +
        chapters
          .map((c) => `<a href="${c.slug}"${c.slug === currentSlug ? ' class="on"' : ''}>${c.title}</a>`)
          .join('')
    )
    .join('');
}

function page({ lang, chapter, all, index }) {
  const body = rewrite(marked.parse(chapter.raw, { async: false }));
  const flat = all.flatMap((g) => g.chapters);
  const prev = flat[index - 1], next = flat[index + 1];
  const nav = renderNav(all, chapter.slug);
  const other = lang === 'zh' ? 'en' : 'zh';
  const url = `https://docs.modelswap.app/${lang}/${chapter.slug}`;
  const desc = escAttr(metaDescription(chapter.raw) || `${TITLES[lang]} — ModelSwap`);
  return `<!DOCTYPE html><html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escAttr(chapter.title)} · ${TITLES[lang]}</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="${url}">
<link rel="alternate" hreflang="zh-CN" href="https://docs.modelswap.app/zh/${chapter.slug}">
<link rel="alternate" hreflang="en" href="https://docs.modelswap.app/en/${chapter.slug}">
<link rel="alternate" hreflang="x-default" href="https://docs.modelswap.app/en/${chapter.slug}">
<meta property="og:title" content="${escAttr(chapter.title)} · ${TITLES[lang]}">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="article">
<meta property="og:url" content="${url}">
<meta property="og:site_name" content="ModelSwap Docs">
<meta name="twitter:card" content="summary">
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
const built = {};
for (const lang of Object.keys(LANGS)) {
  const all = chapters(lang);
  const flat = all.flatMap((g) => g.chapters);
  built[lang] = flat;
  fs.mkdirSync(path.join(OUT, lang), { recursive: true });
  flat.forEach((chapter, index) => {
    fs.writeFileSync(path.join(OUT, lang, chapter.slug + '.html'), page({ lang, chapter, all, index }));
  });
  // images are shared (../images/) → copy once per lang dir
  fs.cpSync(path.join(SRC, 'images'), path.join(OUT, lang, 'images'), { recursive: true });
  // /zh/ index → first chapter
  fs.writeFileSync(path.join(OUT, lang, 'index.html'), `<meta http-equiv="refresh" content="0;url=${flat[0].slug}">`);
}
fs.writeFileSync(path.join(OUT, 'style.css'), CSS);
fs.writeFileSync(path.join(OUT, 'index.html'), `<meta http-equiv="refresh" content="0;url=/zh/">`);

// --- SEO/GEO artifacts: robots.txt, sitemap.xml, llms.txt, IndexNow key ---
// Chapter slugs are shared across languages; hreflang alternates are emitted
// only for slugs that exist in both langs, so a future lang drift can't 404.
const SITE = 'https://docs.modelswap.app';
const INDEXNOW_KEY = '145ae795aef948ab8bde8b95748d75eb';
const today = new Date().toISOString().slice(0, 10);
const slugLangs = new Map();
for (const lang of Object.keys(LANGS)) {
  for (const c of built[lang]) {
    if (!slugLangs.has(c.slug)) slugLangs.set(c.slug, { title: {}, langs: [] });
    slugLangs.get(c.slug).title[lang] = c.title;
    slugLangs.get(c.slug).langs.push(lang);
  }
}
const hreflang = (slug) =>
  slugLangs.get(slug).langs
    .map((lang) => `    <xhtml:link rel="alternate" hreflang="${lang === 'zh' ? 'zh-CN' : 'en'}" href="${SITE}/${lang}/${slug}"/>`)
    .join('\n');

fs.writeFileSync(
  path.join(OUT, 'robots.txt'),
  `# ModelSwap user manual — ${SITE}\n# Search engines and AI assistants are explicitly welcome.\nUser-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`
);

fs.writeFileSync(
  path.join(OUT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${[...slugLangs.keys()]
  .map((slug) =>
    slugLangs
      .get(slug)
      .langs.map((lang, i) => `  <url>\n    <loc>${SITE}/${lang}/${slug}</loc>\n    <lastmod>${today}</lastmod>${i === 0 ? `\n${hreflang(slug)}` : ''}\n  </url>`)
      .join('\n')
  )
  .join('\n')}
</urlset>
`
);

const chapterList = (lang) =>
  built[lang]
    .map((c) => `- [${c.title}](${SITE}/${lang}/${c.slug})`)
    .join('\n');
fs.writeFileSync(
  path.join(OUT, 'llms.txt'),
  `# ModelSwap User Manual

> Official user manual for ModelSwap — an open-source, local-first key & model control plane for AI agents (Claude Code, ChatGPT Codex, Kimi Code and 7 more adapters; 41 provider presets; AES-256-GCM local vault). ${built.zh.length} chapters in Chinese and English covering installation, the encrypted vault, provider & model switching, usage dashboards, sync, snapshots, the CLI and the Agent Skill.

## Chapters (中文)

${chapterList('zh')}

## Chapters (English)

${chapterList('en')}

## Product

- [ModelSwap website](https://modelswap.app/)
- [Product overview for LLMs](https://modelswap.app/llms.txt)
- [Full product reference for LLMs](https://modelswap.app/llms-full.txt)
- [GitHub repository](https://github.com/Cing-self/modelswap)
`
);
fs.writeFileSync(path.join(OUT, `${INDEXNOW_KEY}.txt`), INDEXNOW_KEY);

console.log('docs site built →', OUT);

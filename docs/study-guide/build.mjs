// Builds docs/study-guide/index.html (one self-contained file) from guide.md.
//   npm install --no-save marked@14.1.4 && node docs/study-guide/build.mjs
// No external requests at view time: system fonts, inline CSS/JS/SVG.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { marked } from 'marked'

const dir = path.dirname(fileURLToPath(import.meta.url))
const md = fs.readFileSync(path.join(dir, 'guide.md'), 'utf8')

const slug = (s) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
let html = marked.parse(md, { gfm: true })

// ids on h2/h3 for the nav
html = html.replace(/<h([23])>(.*?)<\/h\1>/g, (_, l, t) => `<h${l} id="${slug(t)}">${t}</h${l}>`)

// Level 3 sections collapsed by default (owner): an h3 whose title says "Level 3" becomes <details>.
html = html.replace(/(<h3 id="[^"]+">([^<]*?Level 3[^<]*?)<\/h3>)([\s\S]*?)(?=<h[23] |<hr>|$)/g, (_, h, title, body) =>
  `<details class="deep"><summary><span class="h3like">${title}</span> <span class="badge">deep dive · open</span></summary>${body}</details>`)

// Diagrams, inserted after the section they illustrate. Colours come from the theme tokens.
const fig = (svg, cap) => `<figure class="diagram">${svg}<figcaption>${cap}</figcaption></figure>`
const box = (x, y, w, h, t, sub = '', cls = '') => `<g class="${cls}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/><text x="${x + w / 2}" y="${y + (sub ? h / 2 - 4 : h / 2 + 5)}" text-anchor="middle" class="t">${t}</text>${sub ? `<text x="${x + w / 2}" y="${y + h / 2 + 14}" text-anchor="middle" class="s">${sub}</text>` : ''}</g>`
const arrow = (x1, y1, x2, y2, label = '') => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#ah)"/>${label ? `<text x="${(x1 + x2) / 2 + 4}" y="${(y1 + y2) / 2 - 5}" class="s">${label}</text>` : ''}`
const defs = `<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="ahead"/></marker></defs>`

const archSvg = `<svg viewBox="0 0 760 400" role="img" aria-label="Architecture: services on one EC2 host and how they connect">${defs}
<rect x="150" y="20" width="590" height="300" rx="16" class="zone"/><text x="165" y="42" class="s">EC2 host · Docker Compose · paper trading only</text>
${box(10, 60, 120, 46, 'Fyers login', 'daily token', 'ext')}${box(10, 160, 120, 46, 'Fyers data', 'WebSocket ticks', 'ext')}${box(10, 262, 120, 46, 'Telegram', 'channel + admin', 'ext')}
${box(175, 60, 135, 46, 'quant_auth', 'writes token')}${box(175, 240, 135, 46, 'quant_scheduler', 'cron, IST')}
${box(350, 140, 160, 70, 'quant_engine', 'ticks → alerts', 'hot')}
${box(565, 60, 155, 46, 'Redis', 'live state')}${box(565, 150, 155, 46, 'Postgres', 'paper_trades, signals')}${box(565, 250, 155, 46, 'quant_api', 'read-only REST + SSE')}
${box(565, 344, 155, 46, 'Vercel dashboard', 'React · /api proxy', 'ext')}
${arrow(130, 83, 173, 83)}${arrow(310, 90, 395, 138, 'token volume')}${arrow(130, 183, 348, 175, 'ticks')}${arrow(310, 258, 380, 212, 'start / stop')}
${arrow(510, 160, 563, 90)}${arrow(510, 178, 563, 175)}${arrow(350, 200, 132, 282)}<text x="200" y="318" class="s">gated alerts</text>
${arrow(640, 196, 640, 248)}<path class="conn" d="M720,83 L734,83 L734,273 L722,273" fill="none" marker-end="url(#ah)"/>${arrow(640, 342, 640, 298, '/api/*')}</svg>`

const tickSvg = `<svg viewBox="0 0 760 170" role="img" aria-label="Life of one tick from WebSocket to Telegram and the paper tracker">${defs}
${box(5, 30, 105, 50, 'Tick', 'Fyers WS')}${box(130, 30, 105, 50, 'VWAP + candle', 'Redis / memory')}${box(255, 30, 105, 50, 'Detectors', '2 equity · 5 Nifty')}
${box(380, 30, 105, 50, 'Filter', 'score ≥ 78')}${box(505, 30, 115, 50, 'Alert policy', 'gated · dedup · cap')}${box(640, 30, 115, 50, 'Telegram', 'channel', 'ext')}
${box(380, 110, 240, 45, 'Paper tracker → Postgres', 'every fire recorded', 'hot')}
${arrow(110, 55, 128, 55)}${arrow(235, 55, 253, 55)}${arrow(360, 55, 378, 55)}${arrow(485, 55, 503, 55)}${arrow(620, 55, 638, 55)}${arrow(432, 80, 470, 108)}</svg>`

const hours = [['07:45', 'token'], ['09:00', 'boot'], ['09:15', 'open'], ['09:25', 'status msg'], ['15:15', 'square-off'], ['15:30', 'stop'], ['15:45', 'summary'], ['16:00', 'backup'], ['16:30', 'screener*'], ['17:15', 'token purge']]
// Evenly spaced (not to scale) so close events stay readable.
const x = (t) => 40 + hours.findIndex(([h]) => h === t) * 75
const daySvg = `<svg viewBox="0 0 760 150" role="img" aria-label="One trading day on the clock, IST (events evenly spaced, not to scale)">
<rect x="${x('09:15') - 10}" y="40" width="${x('15:30') - x('09:15') + 20}" height="26" rx="6" class="session"/><text x="${(x('09:15') + x('15:30')) / 2}" y="58" text-anchor="middle" class="s">session 09:15–15:30</text>
<line x1="20" y1="82" x2="740" y2="82" class="axis"/>
${hours.map(([t, l]) => `<line x1="${x(t)}" y1="76" x2="${x(t)}" y2="88" class="axis"/><text x="${x(t)}" y="106" text-anchor="middle" class="t">${t}</text><text x="${x(t)}" y="122" text-anchor="middle" class="s">${l}</text>`).join('')}
<text x="20" y="24" class="s">* built, not running · events evenly spaced, not to scale · no restarts or deploys 09:00–15:30</text></svg>`

const deploySvg = `<svg viewBox="0 0 760 200" role="img" aria-label="Deploy and rollback flow">${defs}
${box(5, 20, 110, 50, 'copy log', 'recreate deletes it')}${box(130, 20, 110, 50, 'pg_dump', 'verify 3 tables')}${box(255, 20, 120, 50, 'tag rollback', 'current image')}
${box(390, 20, 110, 50, 'build engine', 'only quant_engine')}${box(515, 20, 110, 50, 'create', 'left "Created"')}${box(640, 20, 115, 50, '09:00 cron', 'starts it', 'hot')}
${arrow(115, 45, 128, 45)}${arrow(240, 45, 253, 45)}${arrow(375, 45, 388, 45)}${arrow(500, 45, 513, 45)}${arrow(625, 45, 638, 45)}
${box(255, 120, 370, 55, 'Rollback: tag rollback image as latest', 'then create --force-recreate quant_engine', 'ext')}${arrow(315, 72, 315, 118)}</svg>`

const after = (anchorText, figure) => {
  const re = new RegExp(`(<h3 id="[^"]+">[^<]*${anchorText}[^<]*</h3>)`)
  html = html.replace(re, `$1${figure}`)
}
after('1.3 The architecture tour', fig(archSvg, 'What to notice: only the engine touches market data and Telegram; the API only reads; the dashboard reaches the host only through the /api proxy.'))
after('1.4 The life of one tick', fig(tickSvg, 'What to notice: every fire becomes a paper trade, but only fires that pass the filter and the alert policy reach Telegram.'))
after('1.5 One trading day on the clock', fig(daySvg, 'What to notice: everything that can disturb the session (deploys, restarts, the screener, backups) happens outside 09:15–15:30.'))
after('6.4 The deploy procedure', fig(deploySvg, 'What to notice: a deploy never starts the engine, and the log copy comes first because a recreate deletes it.'))

const nav = [...html.matchAll(/<h([23]) id="([^"]+)">(.*?)<\/h\1>|<span class="h3like">(.*?)<\/span>/g)]
  .filter((m) => m[1])
  .map((m) => `<a class="l${m[1]}" href="#${m[2]}">${m[3].replace(/<[^>]+>/g, '')}</a>`).join('')

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Insider Quant Study Guide</title>
<style>
:root{--bg:#f6f5f2;--surface:#fff;--surface2:#eeece7;--line:#dcd8d0;--fg:#1d2128;--muted:#5d6470;--accent:#2b6a9a;--warn:#9a6400;--hot:#1c8a7a;color-scheme:light;
--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--serif:Georgia,"Iowan Old Style","Palatino Linotype",serif;--mono:ui-monospace,"SFMono-Regular",Consolas,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#11151b;--surface:#171d25;--surface2:#1e2630;--line:#2b3542;--fg:#e4e8ee;--muted:#93a0b0;--accent:#7fb3e6;--warn:#e0a83a;--hot:#3cc2ad;color-scheme:dark}}
:root[data-theme=dark]{--bg:#11151b;--surface:#171d25;--surface2:#1e2630;--line:#2b3542;--fg:#e4e8ee;--muted:#93a0b0;--accent:#7fb3e6;--warn:#e0a83a;--hot:#3cc2ad;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 var(--sans)}
.wrap{display:grid;grid-template-columns:minmax(0,1fr);max-width:1240px;margin:0 auto}
@media(min-width:1000px){.wrap{grid-template-columns:280px minmax(0,1fr)}}
nav.toc{display:none}@media(min-width:1000px){nav.toc{display:block;position:sticky;top:0;height:100vh;overflow-y:auto;padding:20px 14px;border-right:1px solid var(--line);font-size:.86rem}}
nav.toc a{display:block;color:var(--muted);text-decoration:none;padding:3px 6px;border-radius:6px}nav.toc a.l3{padding-left:18px;font-size:.82rem}nav.toc a:hover{color:var(--fg);background:var(--surface2)}
.bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}input#q{flex:1;min-width:0;font:inherit;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--fg)}
button.theme{font:inherit;padding:7px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--fg);cursor:pointer}
main{padding:24px max(16px,env(safe-area-inset-right)) 80px max(16px,env(safe-area-inset-left));min-width:0}@media(min-width:1000px){main{padding:32px 48px}}
article{max-width:72ch}h1,h2,h3,.h3like{font-family:var(--serif);line-height:1.2;text-wrap:balance}h1{font-size:2.1rem}h2{font-size:1.6rem;margin-top:2.4em;border-top:1px solid var(--line);padding-top:1em}h3,.h3like{font-size:1.2rem;margin-top:1.8em}
code{font:.88em var(--mono);background:var(--surface2);padding:1px 5px;border-radius:5px;overflow-wrap:anywhere}pre{background:var(--surface2);padding:12px;border-radius:10px;overflow-x:auto;font-size:.82rem;line-height:1.35}pre code{background:none;padding:0}
table{border-collapse:collapse;width:100%;font-size:.88rem;display:block;overflow-x:auto}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:600}
blockquote{margin:1em 0;padding:10px 14px;border-left:3px solid var(--warn);background:var(--surface);border-radius:0 10px 10px 0}
details{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin:1em 0}summary{cursor:pointer;font-weight:600}
details.deep>summary .badge{font:500 .72rem var(--mono);color:var(--accent);border:1px solid var(--line);border-radius:999px;padding:1px 8px}
a{color:var(--accent)}hr{border:0}
figure.diagram{margin:1.2em 0;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:10px;overflow-x:auto}figure.diagram svg{width:100%;min-width:620px;height:auto;display:block}
figure.diagram figcaption{font-size:.82rem;color:var(--muted);margin-top:6px}
svg rect{fill:var(--surface2);stroke:var(--line)}svg .hot rect{stroke:var(--hot);stroke-width:2}svg .ext rect{fill:var(--surface);stroke-dasharray:4 3}svg rect.zone{fill:none;stroke:var(--line);stroke-dasharray:6 4}
svg rect.session{fill:color-mix(in srgb,var(--hot) 22%,transparent);stroke:none}svg .t{fill:var(--fg);font:600 12px var(--sans)}svg .s{fill:var(--muted);font:11px var(--sans)}svg line,svg path.conn{stroke:var(--muted);stroke-width:1.4}svg .axis{stroke:var(--line);stroke-width:2}svg .ahead{fill:var(--muted)}
.hidden{display:none}:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media print{nav.toc,.bar{display:none}.wrap{display:block}details{border:0}details>*{display:block}body{background:#fff;color:#000}h2{break-before:page}}
</style></head><body>
<div class="wrap"><nav class="toc" aria-label="Contents"><strong style="display:block;margin:0 6px 10px">Contents</strong>${nav}</nav>
<main><div class="bar"><input id="q" type="search" placeholder="Search the guide (e.g. SET NX, VWAP, watchdog)" aria-label="Search the guide"><button class="theme" id="t" type="button">Theme</button></div>
<article id="doc">${html}</article></main></div>
<script>
(function(){var doc=document.getElementById('doc');var q=document.getElementById('q');
// group into h2 sections for search
var secs=[],cur=null;Array.prototype.slice.call(doc.childNodes).forEach(function(n){if(n.nodeName==='H2'){cur=document.createElement('section');doc.insertBefore(cur,n);secs.push(cur)}if(cur&&n!==cur)cur.appendChild(n)});
q.addEventListener('input',function(){var v=q.value.trim().toLowerCase();secs.forEach(function(s){var hit=!v||s.textContent.toLowerCase().indexOf(v)>=0;s.classList.toggle('hidden',!hit);if(v&&hit)s.querySelectorAll('details').forEach(function(d){if(d.textContent.toLowerCase().indexOf(v)>=0)d.open=true})})});
var t=document.getElementById('t');t.addEventListener('click',function(){var r=document.documentElement;var dark=r.dataset.theme?r.dataset.theme==='dark':matchMedia('(prefers-color-scheme: dark)').matches;r.dataset.theme=dark?'light':'dark';try{localStorage.setItem('sg-theme',r.dataset.theme)}catch(e){}});
try{var s=localStorage.getItem('sg-theme');if(s)document.documentElement.dataset.theme=s}catch(e){}
window.addEventListener('beforeprint',function(){document.querySelectorAll('details').forEach(function(d){d.open=true})});})();
</script></body></html>`

fs.writeFileSync(path.join(dir, 'index.html'), page)
console.log(`index.html written: ${(page.length / 1024).toFixed(0)} KB, ${nav.split('<a ').length - 1} nav links, ${(html.match(/class="deep"/g) ?? []).length} level-3 sections collapsed, 4 diagrams`)

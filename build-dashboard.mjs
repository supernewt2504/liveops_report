// data.json → 대시보드 HTML 생성 (실데이터 임베드 · 일간/주간 · 한/중)
// 사용법: node build-dashboard.mjs   → dashboard.html 생성
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
// 런타임 데이터·빌드 산출물 위치 (클라우드=/data 볼륨, 로컬=코드 디렉터리)
const DATA_DIR = process.env.DATA_DIR || DIR;
const db = JSON.parse(readFileSync(join(DATA_DIR, 'data.json'), 'utf8'));
const firstProjId = Object.keys(db.projects)[0];
const projId = process.env.PROJECT || firstProjId; // 프로젝트 선택(기본=첫 프로젝트)
if (!db.projects[projId]) { console.error('✗ data.json 에 프로젝트 없음:', projId, '— collect 먼저 실행'); process.exit(1); }
const cfgProj = (JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf8')).projects || []).find(p => p.id === projId) || {};
// 메일 수신자(프로젝트별) — recipients.json 에서 로드(언어별 {ko,zh} 또는 배열). {email,lang} 배열로.
let recipients = [];
if (existsSync(join(DIR, 'recipients.json'))) {
  try {
    const r = JSON.parse(readFileSync(join(DIR, 'recipients.json'), 'utf8'))[projId];
    if (Array.isArray(r)) r.forEach(e => recipients.push({ email: e, lang: 'ko' }));
    else if (r && typeof r === 'object') for (const lang of ['ko', 'zh']) if (Array.isArray(r[lang])) r[lang].forEach(e => recipients.push({ email: e, lang }));
    recipients = recipients.filter(x => /@/.test(x.email));
  } catch {}
}
const proj = db.projects[projId];
const days = proj.days;
const dates = Object.keys(days).sort();

const stores = { google: { connected: true, free: [], gross: [], reviews: [], rating: [] },
                 apple: { connected: true, free: [], gross: [], reviews: [], rating: [] },
                 onestore: { connected: true, metricsOnly: true, free: [], gross: [], reviews: [], rating: [], totalRatings: null, downloads: null },
                 galaxy: { connected: true, metricsOnly: true, free: [], gross: [], reviews: [], rating: [], totalRatings: null, downloads: null } };
const reviewsByDate = {};
for (const d of dates) {
  const rec = days[d].stores; const arr = [];
  for (const s of ['google', 'apple']) {
    const st = rec[s] || {};
    stores[s].free.push(st.rankFree ?? null);
    stores[s].gross.push(st.rankGrossing ?? null);
    stores[s].reviews.push(st.newCount ?? 0);
    stores[s].rating.push(st.overallScore ?? null); // 당일 누적 별점(스냅샷)
    // sk=스토어, sc=별점, se=감성(분류), tp=주제(분류), x=원문
    for (const r of (st.reviews || [])) arr.push({ sk: s, sc: r.score, se: r.sentiment || null, tp: r.topic || null, x: r.text || '' });
  }
  // 지표 전용 스토어(원스토어/갤럭시): 평점 스냅샷 + 최신 누적평가/다운로드
  for (const s of ['onestore', 'galaxy']) {
    const st = rec[s] || {};
    stores[s].free.push(st.rankFree ?? null); stores[s].gross.push(st.rankGrossing ?? null); stores[s].reviews.push(0);
    stores[s].rating.push(st.overallScore ?? null);
    if (st.totalRatings != null) stores[s].totalRatings = st.totalRatings;
    if (st.downloads != null) stores[s].downloads = st.downloads;
  }
  reviewsByDate[d] = arr;
}
const last = days[dates[dates.length - 1]].stores;

// ---- 네이버 라운지: 일별 누적 게시물 추세 + 최신 스냅샷(최근글/공지/게시판 분포) ----
const loungeSeries = dates
  .filter(d => days[d].lounge)
  .map(d => ({ date: d, totalPosts: days[d].lounge.totalPosts ?? null, newCount: days[d].lounge.newToday ?? null, visitors: days[d].lounge.visitors ?? null }));
// 최신 방문자수(시트 수동입력): 가장 최근 값
let loungeVisitors = null, loungeVisitorsDate = null;
for (let i = loungeSeries.length - 1; i >= 0; i--) { if (loungeSeries[i].visitors != null) { loungeVisitors = loungeSeries[i].visitors; loungeVisitorsDate = loungeSeries[i].date; break; } }
// 최신 '완전' 스냅샷 = recent 글이 있는 마지막 날 (방문자만 있는 날은 제외)
let loungeLatest = null;
for (let i = dates.length - 1; i >= 0; i--) { const lo = days[dates[i]].lounge; if (lo && (lo.recent || []).length) { loungeLatest = { ...lo, date: dates[i] }; break; } }
if (loungeLatest) {
  loungeLatest.visitors = loungeVisitors;
  loungeLatest.visitorsDate = loungeVisitorsDate;
  // recent 원문 배열은 KPI/추이 산출 후 불필요(게시판 탭은 boardFeeds 사용) → 임베드 축소
  delete loungeLatest.recent;
}
// 일자별 라운지 스냅샷(경량): 선택 일자 기준 KPI·요약 표시용. boardFeeds는 latest만(중복 방지).
const loungeByDate = {};
for (const d of dates) {
  const l = days[d].lounge;
  if (l && (l.totalPosts != null || l.summary)) loungeByDate[d] = { totalPosts: l.totalPosts ?? null, newToday: l.newToday ?? null, summary: l.summary || null };
}

// 렌더링할 스토어 목록(프로젝트별). config 의 excludeStores 로 특정 스토어 제외 (예: 소년가행=갤럭시 미오픈)
const ALL_STORES = ['google', 'apple', 'onestore', 'galaxy'];
const storeList = ALL_STORES.filter(s => !(cfgProj.excludeStores || []).includes(s));

const REAL = {
  projectName: proj.name, projectNameZh: cfgProj.nameZh || proj.name, country: (db.meta?.country || 'kr').toUpperCase(), lastRun: db.meta?.lastRun || '',
  dates, stores, reviewsByDate, storeList, icons: proj.icons || {}, recipients: recipients,
  lounge: loungeLatest ? { latest: loungeLatest, series: loungeSeries, byDate: loungeByDate } : null,
  cs: (cfgProj.helpdesk && proj.cs) ? proj.cs : null,   // 고객센터(helpdesk) 집계 — helpdesk=true 프로젝트만
  totals: {
    google: { overallScore: last.google?.overallScore ?? null, totalRatings: last.google?.totalRatings ?? null },
    apple: { overallScore: last.apple?.overallScore ?? null, totalRatings: last.apple?.totalRatings ?? null },
  },
};

const TPL = TEMPLATE(JSON.stringify(REAL));
const gen = (lang, showBar) => TPL.replace('__DEFAULTLANG__', lang).replace('__SHOWMAILBAR__', showBar ? 'true' : 'false');
// 파일명: 첫 프로젝트=dashboard(기존 호환), 그 외=dashboard-<projId>
const base = projId === firstProjId ? 'dashboard' : `dashboard-${projId}`;
writeFileSync(join(DATA_DIR, `${base}.html`), gen('ko', true));        // 운영자용 ko (수신자 바 O)
writeFileSync(join(DATA_DIR, `${base}-zh.html`), gen('zh', true));     // 운영자용 zh
writeFileSync(join(DATA_DIR, `${base}-mail.html`), gen('ko', false));  // 메일 첨부 ko (바 X)
writeFileSync(join(DATA_DIR, `${base}-mail-zh.html`), gen('zh', false)); // 메일 첨부 zh
console.log(`✓ [${projId}] ${base}(.html/-zh/-mail/-mail-zh) 생성 (일자 ${dates.length}개, 최신 ${dates[dates.length - 1]})`);

function TEMPLATE(dataJson) {
  return `<title>운영 대시보드 · ${REAL.projectName}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Noto+Sans+SC:wght@400;500;600;700&display=swap">
<style>
  :root{--bg:#eef1f6;--surface:#fff;--surface-2:#f6f8fc;--surface-3:#eef2f8;--border:#dce2ec;--border-strong:#c4cddc;
    --ink:#161b26;--ink-2:#414b5e;--ink-3:#6b7688;--accent:#2555d6;--accent-soft:#e5ecfd;
    --good:#0f8a4c;--good-soft:#dcf3e6;--bad:#c62a3b;--bad-soft:#fbe3e6;--warn:#b56a09;--warn-soft:#fbeed6;--neu:#8a94a6;
    --shadow:0 1px 2px rgba(20,27,38,.05),0 6px 20px rgba(20,27,38,.06);--ring:0 0 0 3px rgba(37,85,214,.28);}
  @media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#0c0f16;--surface:#141924;--surface-2:#1a2130;--surface-3:#212a3b;
    --border:#28303f;--border-strong:#3a4557;--ink:#eef2f8;--ink-2:#b3bece;--ink-3:#7e8a9c;--accent:#6c93ff;--accent-soft:#1c2740;
    --good:#4dc98a;--good-soft:#123526;--bad:#ff7484;--bad-soft:#3a1720;--warn:#e3a94e;--warn-soft:#372814;--neu:#8a94a6;
    --shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.35);--ring:0 0 0 3px rgba(108,147,255,.35);}}
  :root[data-theme="dark"]{--bg:#0c0f16;--surface:#141924;--surface-2:#1a2130;--surface-3:#212a3b;
    --border:#28303f;--border-strong:#3a4557;--ink:#eef2f8;--ink-2:#b3bece;--ink-3:#7e8a9c;--accent:#6c93ff;--accent-soft:#1c2740;
    --good:#4dc98a;--good-soft:#123526;--bad:#ff7484;--bad-soft:#3a1720;--warn:#e3a94e;--warn-soft:#372814;--neu:#8a94a6;
    --shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.35);--ring:0 0 0 3px rgba(108,147,255,.35);}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:"IBM Plex Sans KR","Noto Sans SC",system-ui,"Apple SD Gothic Neo",sans-serif;line-height:1.55;-webkit-font-smoothing:antialiased}
  .mono{font-family:"IBM Plex Mono",monospace;font-variant-numeric:tabular-nums}
  .wrap{max-width:1180px;margin:0 auto;padding:22px 20px 72px}
  header.top{display:flex;flex-wrap:wrap;align-items:flex-end;gap:14px 22px;padding-bottom:18px;margin-bottom:22px;border-bottom:1px solid var(--border)}
  .eyebrow{font-family:"IBM Plex Mono",monospace;font-size:11px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--accent)}
  h1{margin:2px 0 0;font-size:clamp(20px,2.6vw,27px);font-weight:700;letter-spacing:-.02em;line-height:1.15}
  .cat{font-size:12px;color:var(--ink-3);font-family:"IBM Plex Mono",monospace;margin-top:3px}
  .ctrl{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .ctrl label{font-size:12px;color:var(--ink-3);font-weight:500}
  .ctrl select{font-family:"IBM Plex Mono","Noto Sans SC",monospace;font-size:13.5px;font-weight:600;color:var(--ink);background:var(--surface);
    border:1px solid var(--border-strong);border-radius:9px;padding:8px 11px;cursor:pointer;box-shadow:var(--shadow)}
  .ctrl select:focus-visible{outline:none;box-shadow:var(--ring)}
  .seg{display:inline-flex;background:var(--surface-3);border-radius:9px;padding:3px;gap:2px}
  .seg button{font-family:inherit;font-size:13px;font-weight:600;color:var(--ink-3);background:none;border:none;border-radius:7px;padding:6px 12px;cursor:pointer}
  .seg button.on{background:var(--surface);color:var(--accent);box-shadow:var(--shadow)}
  .latest{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:var(--good);background:var(--good-soft);
    padding:5px 10px;border-radius:999px;font-family:"IBM Plex Mono",monospace}
  .latest::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--good)}
  .latest.hide{display:none}
  .pdf-btn{font-family:"IBM Plex Sans KR","Noto Sans SC",sans-serif;font-size:13px;font-weight:600;color:#fff;background:var(--accent);border:none;
    border-radius:9px;padding:9px 14px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;box-shadow:var(--shadow)}
  .pdf-btn:hover{filter:brightness(1.08)}
  .pdf-btn:focus-visible{outline:none;box-shadow:var(--ring)}
  .print-only{display:none}
  .summary{background:var(--surface);border:1px solid var(--border);border-radius:14px;margin-bottom:24px;box-shadow:var(--shadow);overflow:hidden}
  .hl-basis{display:flex;flex-wrap:wrap;align-items:center;gap:2px 8px;padding:10px 18px;border-bottom:1px solid var(--border);font-family:"IBM Plex Mono",monospace;font-size:11.5px;color:var(--ink-3);background:var(--surface-2,transparent)}
  .hl-basis .lbl{font-weight:600;letter-spacing:.04em;color:var(--ink-2)}
  .hl-basis .val{font-weight:600;color:var(--ink)}
  .hl-basis .dot{color:var(--ink-3);opacity:.6}
  .hl-basis .sub{color:var(--ink-3);font-weight:500}
  .hl-strip{display:grid;grid-template-columns:repeat(5,1fr)}
  @media(max-width:760px){.hl-strip{grid-template-columns:repeat(2,1fr)}}
  @media(max-width:420px){.hl-strip{grid-template-columns:1fr}}
  /* 소형 모바일: 여백 축소 + 헤더 컨트롤 전체폭 정렬 */
  @media(max-width:560px){
    .wrap{padding:16px 13px 56px}
    header.top{gap:12px 14px}
    .ctrl{width:100%;margin-left:0;justify-content:flex-start}
    .hl-basis{padding:9px 14px}
  }
  .hl{display:flex;flex-direction:column;gap:5px;padding:16px 18px;border-right:1px solid var(--border);border-bottom:1px solid var(--border)}
  .hl:last-child{border-right:none}
  .hl .k{font-size:11.5px;color:var(--ink-3);font-weight:500}
  .hl .v{display:flex;align-items:baseline;gap:6px}
  .hl .v .num{font-family:"IBM Plex Mono",monospace;font-size:24px;font-weight:600;letter-spacing:-.02em;line-height:1}
  .hl .v .num.good{color:var(--good)}
  .hl .v .num.small{font-size:16px}
  .hl .v .num.na{font-size:16px;font-weight:500;color:var(--ink-3);white-space:nowrap}
  .hl .v .unit{font-size:12px;color:var(--ink-3)}
  .hl .sub{font-size:11px;color:var(--ink-3);font-family:"IBM Plex Mono",monospace}
  section{margin-bottom:30px}
  .sec-head{display:flex;align-items:baseline;gap:11px;margin:0 2px 14px}
  .sec-head h2{margin:0;font-size:17px;font-weight:700;letter-spacing:-.01em}
  .sec-head .hint{font-size:12px;color:var(--ink-3)}
  .stores{display:grid;grid-template-columns:repeat(auto-fit,minmax(258px,1fr));gap:14px}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:16px;box-shadow:var(--shadow)}
  .card.off{opacity:.85;border-style:dashed;background:var(--surface-2)}
  .card-h{display:flex;align-items:center;gap:9px;margin-bottom:12px}
  .logo{width:26px;height:26px;border-radius:7px;display:grid;place-items:center;font-weight:700;font-size:13px;color:#fff;font-family:"IBM Plex Mono",monospace}
  .logo-img{width:26px;height:26px;border-radius:7px;object-fit:cover;display:block;background:var(--surface-3)}
  .card-h .name{font-weight:600;font-size:14.5px}
  .badge-off{margin-left:auto;font-size:10.5px;font-weight:600;color:var(--ink-3);background:var(--surface-3);padding:3px 8px;border-radius:999px}
  .metrics{display:grid;grid-template-columns:1fr 1fr;gap:10px 12px}
  .metric{display:flex;flex-direction:column;gap:2px}
  .metric .k{font-size:11px;color:var(--ink-3);font-weight:500}
  .metric .v{display:flex;align-items:baseline;gap:6px}
  .metric .v .num{font-family:"IBM Plex Mono",monospace;font-size:20px;font-weight:600;letter-spacing:-.02em}
  .metric .v .num.na{font-size:13px;color:var(--ink-3);font-weight:500;white-space:nowrap}
  .metric .v .unit{font-size:12px;color:var(--ink-3)}
  .delta{font-family:"IBM Plex Mono",monospace;font-size:12px;font-weight:600;display:inline-flex;align-items:center;gap:1px;padding:1px 5px;border-radius:5px}
  .delta.up{color:var(--good);background:var(--good-soft)} .delta.down{color:var(--bad);background:var(--bad-soft)} .delta.flat{color:var(--ink-3);background:var(--surface-3)}
  .card-note{margin-top:12px;padding-top:11px;border-top:1px solid var(--border);font-size:11.5px;color:var(--ink-3);font-family:"IBM Plex Mono","Noto Sans SC",monospace}
  .off-msg{font-size:12.5px;color:var(--ink-3);padding:14px 2px 4px;line-height:1.6}
  .grid-2{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);gap:14px}
  @media(max-width:820px){.grid-2{grid-template-columns:1fr}}
  .panel{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:16px 18px;box-shadow:var(--shadow)}
  .panel.off{border-style:dashed;background:var(--surface-2)}
  .panel h3{margin:0 0 3px;font-size:14px;font-weight:600}
  .panel .sub{margin:0 0 14px;font-size:12px;color:var(--ink-3)}
  .senti-bar{display:flex;height:26px;border-radius:7px;overflow:hidden;margin-bottom:9px;border:1px solid var(--border)}
  .senti-bar .pos{background:var(--good)} .senti-bar .neu{background:var(--neu)} .senti-bar .neg{background:var(--bad)}
  .senti-legend{display:flex;gap:16px;font-size:12px;flex-wrap:wrap}
  .senti-legend .li{display:flex;align-items:center;gap:6px;color:var(--ink-2)}
  .senti-legend .dot{width:10px;height:10px;border-radius:3px} .senti-legend .mono{color:var(--ink);font-weight:600}
  .topics-title{font-size:12px;color:var(--ink-3);font-weight:600;margin:18px 0 10px}
  .topics{display:flex;flex-direction:column;gap:9px}
  .topic{display:grid;grid-template-columns:96px 1fr auto;align-items:center;gap:10px}
  .topic .tn{font-size:12.5px;color:var(--ink-2);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .topic .track{display:block;height:9px;background:var(--surface-3);border-radius:999px;overflow:hidden}
  .topic .fill{display:block;height:100%;border-radius:999px;min-width:6px}
  .topic .tc{font-family:"IBM Plex Mono",monospace;font-size:12px;color:var(--ink)}
  .chip.topic{background:var(--accent-soft);color:var(--accent)}
  .reviews{display:flex;flex-direction:column;gap:10px}
  .rv{border:1px solid var(--border);border-radius:10px;padding:11px 12px;background:var(--surface-2)}
  .rv-h{display:flex;align-items:center;gap:8px;margin-bottom:5px;flex-wrap:wrap}
  .stars{font-family:"IBM Plex Mono",monospace;font-size:12px;font-weight:600}
  .chip{font-size:10.5px;font-weight:600;padding:2px 7px;border-radius:999px}
  .chip.store{background:var(--surface-3);color:var(--ink-2)} .chip.neg{background:var(--bad-soft);color:var(--bad)}
  .chip.pos{background:var(--good-soft);color:var(--good)} .chip.neu{background:var(--surface-3);color:var(--ink-3)}
  .rv p{margin:0;font-size:13px;color:var(--ink-2);line-height:1.5}
  .empty{font-size:13px;color:var(--ink-3);padding:8px 2px}
  .lounge-kpi{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin-bottom:14px}
  @media(max-width:620px){.lounge-kpi{grid-template-columns:1fr}}
  .events{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:11px}
  .event{display:block;text-decoration:none;color:inherit;border:1px solid var(--border);border-radius:11px;padding:12px 13px;background:var(--surface-2)}
  .event:hover{border-color:var(--accent);box-shadow:var(--shadow)}
  .ev-top{display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap}
  .ev-badge{font-size:10px;font-weight:700;color:#fff;background:var(--good);padding:2px 8px;border-radius:999px}
  .ev-badge.ended{background:var(--neu)}
  .ev-period{font-size:11.5px;font-family:"IBM Plex Mono",monospace;color:var(--accent);font-weight:600}
  .ev-title{font-size:13.5px;font-weight:700;line-height:1.4;margin-bottom:4px}
  .ev-content{font-size:12.5px;color:var(--ink-2);line-height:1.5}
  .lk{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:15px 17px;box-shadow:var(--shadow);display:flex;flex-direction:column;gap:6px}
  .lk .k{font-size:11.5px;color:var(--ink-3);font-weight:500}
  .lk .v{display:flex;align-items:baseline;gap:6px}
  .lk .v .num{font-family:"IBM Plex Mono",monospace;font-size:26px;font-weight:600;letter-spacing:-.02em;line-height:1}
  .lk .v .num.na{font-size:15px;font-weight:500;color:var(--ink-3)}
  .lk .v .unit{font-size:12px;color:var(--ink-3)}
  .lk .sub{font-size:10.5px;color:var(--ink-3);font-family:"IBM Plex Mono",monospace}
  .feed{display:block;border:1px solid var(--border);border-radius:10px;padding:10px 12px;background:var(--surface-2);text-decoration:none;color:inherit}
  .feed+.feed{margin-top:9px}
  .feed:hover{border-color:var(--border-strong)}
  .feed-h{display:flex;align-items:center;gap:7px;margin-bottom:4px;flex-wrap:wrap}
  .feed-t{font-size:13px;font-weight:600;color:var(--ink);line-height:1.4}
  .feed-m{display:flex;gap:11px;font-size:10.5px;color:var(--ink-3);font-family:"IBM Plex Mono",monospace;margin-top:5px;flex-wrap:wrap}
  .chip.board{background:var(--accent-soft);color:var(--accent)}
  .sum-gist{margin:0 0 13px;font-size:13.5px;line-height:1.6;color:var(--ink-2)}
  .sum-topics{display:flex;flex-direction:column;gap:8px}
  .sum-topic{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}
  .sum-topic .chip{flex:none}
  .sum-note{font-size:12.5px;color:var(--ink-2);line-height:1.45}
  .lchart-wrap{width:100%}
  .lchart{width:100%;height:auto;display:block}
  .ct-val{font-family:"IBM Plex Mono",monospace;font-size:12px;font-weight:600;fill:var(--accent)}
  .ct-val0{font-family:"IBM Plex Mono",monospace;font-size:11px;fill:var(--ink-3)}
  .ct-date{font-family:"IBM Plex Mono",monospace;font-size:11px;font-weight:500;fill:var(--ink-2)}
  .ct-wd{font-size:10px;fill:var(--ink-3)}
  /* 고객센터(CS) */
  .lk .v .num.warn{color:var(--warn)}
  .csbar-new{fill:var(--accent)} .csbar-res{fill:var(--good)}
  .cs-legend{display:flex;gap:16px;margin:2px 0 6px;font-size:12px;color:var(--ink-2)}
  .cs-legend .lg{display:inline-flex;align-items:center;gap:6px}
  .cs-legend .sw{width:11px;height:11px;border-radius:3px;display:inline-block}
  .cs-legend .sw.csbar-new{background:var(--accent)} .cs-legend .sw.csbar-res{background:var(--good)}
  .cs-dist h3{margin:0 0 10px}
  .cs-dist-row{display:flex;align-items:center;gap:10px;margin-bottom:7px}
  .cs-dist-name{flex:none;width:74px;font-size:12.5px;color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cs-dist-bar{flex:1;height:8px;background:var(--surface-3);border-radius:999px;overflow:hidden}
  .cs-dist-fill{display:block;height:100%;background:var(--accent);border-radius:999px;min-width:4px}
  .cs-dist-n{flex:none;font-family:"IBM Plex Mono",monospace;font-size:12px;font-weight:600;color:var(--ink-2);min-width:24px;text-align:right}
  .sub.na{color:var(--ink-3)}
  .bhead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:12px}
  .bhead h3{margin:0}.bhead .sub{margin:0;font-size:12px;color:var(--ink-3)}
  .btabs{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:14px}
  .btab{font-family:inherit;font-size:12.5px;font-weight:600;color:var(--ink-2);background:var(--surface-2);border:1px solid var(--border);border-radius:999px;padding:6px 13px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
  .btab:hover{border-color:var(--border-strong)}
  .btab.on{background:var(--accent);border-color:var(--accent);color:#fff}
  .btab em{font-style:normal;font-family:"IBM Plex Mono",monospace;font-size:11px;opacity:.85;background:rgba(255,255,255,.22);padding:0 5px;border-radius:999px}
  .btab:not(.on) em{background:var(--surface-3);color:var(--ink-3)}
  .btab-head{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;margin-bottom:8px}
  .btab-head h4{margin:0;font-size:15px;font-weight:700}
  .btab-head .grp{font-size:11px;font-weight:600;color:var(--accent);background:var(--accent-soft);padding:2px 8px;border-radius:999px}
  .btab-head .bcnt{font-size:11.5px;color:var(--ink-3);font-family:"IBM Plex Mono",monospace;margin-left:auto}
  .board-sum{margin:0 0 13px;font-size:13px;line-height:1.6;color:var(--ink-2);background:var(--surface-2);border-left:3px solid var(--accent);border-radius:0 8px 8px 0;padding:10px 13px}
  .board-sum.na{color:var(--ink-3);border-left-color:var(--border-strong)}
  footer{margin-top:18px;padding-top:16px;border-top:1px solid var(--border);font-size:11.5px;color:var(--ink-3);display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}
  .mono-note{font-family:"IBM Plex Mono","Noto Sans SC",monospace}
  .mail-recipients{margin-top:14px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;box-shadow:var(--shadow)}
  .mail-recipients .mh{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;margin-bottom:11px}
  .mail-recipients .mh h4{margin:0;font-size:13.5px;font-weight:700}
  .mail-recipients .mh .cnt{font-size:11.5px;font-family:"IBM Plex Mono",monospace;color:var(--accent);font-weight:600;background:var(--accent-soft);padding:1px 8px;border-radius:999px}
  .mail-recipients .mh .note{font-size:11px;color:var(--ink-3);margin-left:auto}
  .mail-list{display:flex;flex-wrap:wrap;gap:8px}
  .mail-chip{display:inline-flex;align-items:center;gap:7px;font-family:"IBM Plex Mono",monospace;font-size:12px;color:var(--ink-2);background:var(--surface-2);border:1px solid var(--border);border-radius:999px;padding:5px 11px}
  .mail-chip::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--good)}
  .mail-lang{font-size:10px;font-weight:600;color:var(--accent);background:var(--accent-soft);border-radius:999px;padding:1px 6px}
  .mail-lang.zh{color:#b45309;background:#fbe7cf}
  .mail-empty{font-size:12.5px;color:var(--ink-3)}
  @media print{:root{--bg:#fff;--surface:#fff;--surface-2:#f6f8fc;--surface-3:#eef2f8;--border:#d3dae5;--ink:#161b26;--ink-2:#414b5e;--ink-3:#6b7688;--shadow:none}
    body{background:#fff}.wrap{max-width:none;padding:6px 0 0}.ctrl{display:none!important}
    .print-only{display:block;font-family:"IBM Plex Mono","Noto Sans SC",monospace;font-size:12px;color:var(--ink-3);margin-top:4px}
    .card,.panel,.summary{box-shadow:none}section,.summary,.card,.panel,.grid-2{break-inside:avoid}}
</style>

<div class="wrap">
  <header class="top">
    <div>
      <span class="eyebrow" id="eyebrow"></span>
      <h1 id="title"></h1>
      <div class="cat" id="cat"></div>
      <span class="print-only" id="printMeta"></span>
    </div>
    <div class="ctrl">
      <span class="seg" id="modeSeg"><button data-m="daily" class="on" id="mDaily"></button><button data-m="weekly" id="mWeekly"></button></span>
      <label id="periodLabel" for="period"></label>
      <select id="period"></select>
      <span class="latest" id="latestBadge"></span>
      <label id="langLabel" for="lang"></label>
      <select id="lang"><option value="ko">한국어</option><option value="zh">中文</option></select>
      <button id="pdfBtn" class="pdf-btn"><span>⤓</span> <span id="pdfTxt"></span></button>
    </div>
  </header>
  <div class="summary"><div class="hl-basis" id="hlBasis"></div><div class="hl-strip" id="hlStrip"></div></div>
  <section>
    <div class="sec-head"><h2 id="storeH"></h2><span class="hint" id="storeHint"></span></div>
    <div class="stores" id="stores"></div>
  </section>
  <section>
    <div class="sec-head"><h2 id="rvH"></h2><span class="hint" id="rvHint"></span></div>
    <div class="grid-2">
      <div class="panel">
        <h3 id="sentiH"></h3><p class="sub" id="reviewSub"></p>
        <div class="senti-bar" id="sentiBar"></div>
        <div class="senti-legend" id="sentiLegend"></div>
        <div class="topics-title" id="topicsTitle"></div>
        <div class="topics" id="topics"></div>
      </div>
      <div class="panel">
        <h3 id="notableH"></h3><p class="sub" id="notableSub"></p>
        <div class="reviews" id="reviews"></div>
      </div>
    </div>
  </section>
  <section>
    <div class="sec-head"><h2 id="loungeH"></h2><span class="hint" id="loungeHint"></span></div>
    <div id="loungeWrap"></div>
  </section>
  <section id="csSection" style="display:none">
    <div class="sec-head"><h2 id="csH"></h2><span class="hint" id="csHint"></span></div>
    <div id="csWrap"></div>
  </section>
  <footer><span class="mono-note" id="src"></span><span id="footR"></span></footer>
  <div class="mail-recipients" id="mailBox"></div>
</div>

<script>
var REAL = ${dataJson};
var DATES = REAL.dates;
var T = {
  ko:{ reportDaily:"Daily Operations Report", reportWeekly:"Weekly Operations Report",
    dash:"운영 대시보드", basis:"순위 기준: 게임 전체", country:"국가", daily:"일간", weekly:"주간",
    periodDay:"보고 일자", periodWeek:"보고 주차", lang:"언어", latest:"최신", pdf:"PDF 저장",
    reportDailyDoc:"일간 운영보고서", reportWeeklyDoc:"주간 운영보고서",
    hlCollected:"수집일", hlDataBasis:"데이터 기준일", hlBasisWeek:"집계 기준 주차",
    kGGross:"구글 매출순위", kAGross:"애플 매출순위", kNew:"신규 리뷰 (통합)", kPos:"긍정 리뷰", kGRate:"구글 누적 별점",
    negP:"부정", cum:"누적", noRank:"순위 없음",
    storeH:"스토어 현황", storeHint:"순위=게임 전체 카테고리 · 순위 없음=차트 200위 밖",
    rFree:"인기 순위", rGross:"매출 순위", newR:"신규 리뷰", cumRate:"누적 별점", noRate:"집계 전",
    downloads:"다운로드", totalRatings:"누적 평가", metricsBadge:"지표", metricsNote:"전체 게임 차트 순위 (시트·자동 연동)",
    trendAcc:"순위 추세: 데이터 축적 중 (매일 수집)", trendN:"순위 추세 %d일 누적", off:"미연동", offDesc:"전용 스크래퍼 연동 예정",
    rvH:"리뷰 분석", rvHint:"구글+애플 통합 · 감성은 별점 기반",
    sentiH:"감성 분포", pos:"긍정", neu:"중립", neg:"부정",
    topicsTitle:"주제별 언급 (분류 기반)",
    topics:{"칭찬":"칭찬","콘텐츠":"콘텐츠","계정/로그인":"계정/로그인","과금":"과금","뽑기/확률":"뽑기/확률","버그/접속":"버그/접속","편의성":"편의성","보상/리워드":"보상/리워드","기타":"기타","미분류":"미분류"},
    notableH:"주목 리뷰", notableSub:"긍정 %p · 부정 %n", noNew:"해당 기간 신규 리뷰가 없습니다.",
    loungeH:"네이버 라운지", loungeHint:"연동됨 · 공개 커뮤니티 API",
    loungeMsg:"🔌 라운지 데이터가 아직 수집되지 않았습니다. collect.mjs 실행 후 표시됩니다.",
    loungeSnap:"스냅샷 %d", loungeBasis:"기준 %d", loungeFromLatest:"최신 스냅샷(%d) 기준", loungeKpiPosts:"누적 게시물", loungeKpiNew:"당일 신규 글", loungeKpiNewWeek:"기간 신규 글", loungeKpiVisit:"방문자수",
    loungeVisitNote:"관리자 통계 · 수동 입력", loungeNoVisit:"미입력",
    loungeNotices:"진행 이벤트 · 운영 공지", loungeNoNotice:"최근 수집분에 공지·점검 글이 없습니다.",
    loungeDist:"최근글 게시판 분포", loungeTop:"주목 게시글", loungeTopSub:"공감·댓글 많은 유저 글",
    loungeSummary:"라운지 여론 요약", loungeSummarySub:"최근 %n개 글 기반 · AI 분석", loungeSummaryNone:"요약 미생성 — classify.mjs(키) 또는 로컬 세션에서 채웁니다.",
    loungeTrend:"라운지 추이", loungeTrendNew:"일별 신규글", loungeTrendPosts:"누적 게시물", loungeTrendVisit:"방문자수",
    loungeTrendAcc:"추세 데이터 축적 중 · 현재 %d일 (매일 수집)",
    loungeTrendDay:"일별 신규 게시글 · 최근 7일 (%s ~ %e)", loungeTrendWeek:"일별 신규 게시글 · %s ~ %e",
    loungeBoardsH:"게시판별 글", loungeBoardsHint:"기간 내 새 글이 올라온 게시판 · 탭 클릭 시 요약+글", loungeBoardNone:"이 기간에 새 글이 올라온 게시판이 없습니다.", boardPeriodCnt:"기간 내 %n글",
    loungeEventsH:"진행 이벤트", loungeEventsHint:"이 기간 진행 %n건 · 클릭 시 원문", loungeEventOngoing:"진행중", loungeEventEnded:"종료", loungeEventNone:"이 기간에 진행 중이던 이벤트가 없습니다.",
    loungeBoards:"게시판 %n개", loungeComment:"댓글", loungeBuff:"공감", loungeRead:"조회",
    csH:"고객센터", csHint:"메일 문의 통합 · 최근 30일",
    csKInquiry:"신규 문의", csKResolved:"처리 완료", csKPending:"미처리",
    csTrend:"문의·처리 추이", csTrendDay:"일별 문의·처리 · 최근 7일 (%s ~ %e)", csTrendWeek:"일별 문의·처리 · %s ~ %e",
    csLegendNew:"신규 문의", csLegendResolved:"처리 완료",
    csByCategory:"분류별 문의", csByStatus:"상태 분포",
    csSummary:"문의 현황 요약", csSummarySub:"최근 %n건 기반 · AI 분석", csSummaryNone:"요약 미생성 (ANTHROPIC_API_KEY 필요)",
    csNone:"고객센터 데이터가 아직 없습니다.",
    unitRank:"위", unitCnt:"건", subDay:"%d 신규 리뷰 %n건 기준", subWeek:"%d 주간 신규 리뷰 %n건 기준",
    src:"◈ 실데이터 · 최근 수집 %t · 일자 %n개", footR:"구글 · 애플 · 라운지 연동 · 원스토어/갤럭시 지표",
    mailH:"📩 이 리포트 메일 수신자", mailCount:"%n명", mailNote:"추가·제외는 운영자에게 요청 (recipients.json 관리)", mailNone:"수신자 미설정 — recipients.json 에 추가하세요.",
    store:{google:"구글플레이",apple:"애플 앱스토어",onestore:"원스토어",galaxy:"갤럭시스토어"},
    wd:["일","월","화","수","목","금","토"] },
  zh:{ reportDaily:"日运营报告", reportWeekly:"周运营报告",
    dash:"运营仪表板", basis:"排名基准: 游戏总榜", country:"国家", daily:"日报", weekly:"周报",
    periodDay:"报告日期", periodWeek:"报告周", lang:"语言", latest:"最新", pdf:"PDF 保存",
    reportDailyDoc:"日运营报告", reportWeeklyDoc:"周运营报告",
    hlCollected:"采集日", hlDataBasis:"数据基准日", hlBasisWeek:"统计基准周",
    kGGross:"Google 畅销榜", kAGross:"Apple 畅销榜", kNew:"新增评论 (合计)", kPos:"好评", kGRate:"Google 累计评分",
    negP:"差评", cum:"累计", noRank:"无排名",
    storeH:"商店概况", storeHint:"排名=游戏总榜 · 无排名=榜单200名外",
    rFree:"免费榜", rGross:"畅销榜", newR:"新增评论", cumRate:"累计评分", noRate:"未统计",
    downloads:"下载量", totalRatings:"累计评价", metricsBadge:"指标", metricsNote:"游戏总榜排名 (表格·自动)",
    trendAcc:"排名趋势: 数据积累中 (每日采集)", trendN:"排名趋势 %d日累计", off:"未接入", offDesc:"专用采集器 待接入",
    rvH:"评论分析", rvHint:"Google+Apple 合计 · 情感基于评分",
    sentiH:"情感分布", pos:"好评", neu:"中评", neg:"差评",
    topicsTitle:"主题分布 (基于分类)",
    topics:{"칭찬":"好评","콘텐츠":"内容","계정/로그인":"账号/登录","과금":"付费","뽑기/확률":"抽卡/概率","버그/접속":"BUG/连接","편의성":"易用性","보상/리워드":"奖励","기타":"其他","미분류":"未分类"},
    notableH:"重点评论", notableSub:"好评 %p · 差评 %n", noNew:"该期间没有新增评论。",
    loungeH:"NAVER Lounge", loungeHint:"已接入 · 公开社区 API",
    loungeMsg:"🔌 尚未采集论坛数据。运行 collect.mjs 后显示。",
    loungeSnap:"快照 %d", loungeBasis:"基准 %d", loungeFromLatest:"基于最新快照(%d)", loungeKpiPosts:"累计帖子", loungeKpiNew:"当日新帖", loungeKpiNewWeek:"期间新帖", loungeKpiVisit:"访问量",
    loungeVisitNote:"管理后台统计 · 手动录入", loungeNoVisit:"未录入",
    loungeNotices:"进行中活动 · 运营公告", loungeNoNotice:"最近采集中没有公告·维护帖。",
    loungeDist:"最近帖板块分布", loungeTop:"重点帖子", loungeTopSub:"点赞·评论较多的用户帖",
    loungeSummary:"论坛舆情摘要", loungeSummarySub:"基于最近%n条帖 · AI 分析", loungeSummaryNone:"尚未生成摘要 — 由 classify.mjs(密钥) 或本地会话填充。",
    loungeTrend:"论坛趋势", loungeTrendNew:"每日新帖", loungeTrendPosts:"累计帖子", loungeTrendVisit:"访问量",
    loungeTrendAcc:"趋势数据积累中 · 当前%d日(每日采集)",
    loungeTrendDay:"每日新帖 · 最近7天 (%s ~ %e)", loungeTrendWeek:"每日新帖 · %s ~ %e",
    loungeBoardsH:"板块帖子", loungeBoardsHint:"该期间有新帖的板块 · 点击标签查看摘要+帖子", loungeBoardNone:"该期间没有新帖的板块。", boardPeriodCnt:"期间%n帖",
    loungeEventsH:"进行中活动", loungeEventsHint:"该期间进行%n项 · 点击查看原文", loungeEventOngoing:"进行中", loungeEventEnded:"已结束", loungeEventNone:"该期间没有进行中的活动。",
    loungeBoards:"共%n个板块", loungeComment:"评论", loungeBuff:"点赞", loungeRead:"浏览",
    csH:"客服中心", csHint:"邮件咨询整合 · 近30天",
    csKInquiry:"新增咨询", csKResolved:"已处理", csKPending:"未处理",
    csTrend:"咨询·处理趋势", csTrendDay:"每日咨询·处理 · 近7天 (%s ~ %e)", csTrendWeek:"每日咨询·处理 · %s ~ %e",
    csLegendNew:"新增咨询", csLegendResolved:"已处理",
    csByCategory:"按分类", csByStatus:"状态分布",
    csSummary:"咨询概况摘要", csSummarySub:"基于最近%n件 · AI 分析", csSummaryNone:"尚未生成摘要 (需 ANTHROPIC_API_KEY)",
    csNone:"暂无客服数据。",
    unitRank:"名", unitCnt:"条", subDay:"%d 新增评论 共%n条", subWeek:"%d 周新增评论 共%n条",
    src:"◈ 实时数据 · 最近采集 %t · 天数 %n", footR:"已接入 Google · Apple · Lounge · ONE Store/Galaxy 指标",
    mailH:"📩 本报告邮件收件人", mailCount:"%n人", mailNote:"增删请联系运营(管理 recipients.json)", mailNone:"未设置收件人 — 请在 recipients.json 添加。",
    store:{google:"Google Play",apple:"App Store",onestore:"ONE Store",galaxy:"Galaxy Store"},
    wd:["周日","周一","周二","周三","周四","周五","周六"] }
};
var SMC = {google:"#00875a",apple:"#4b5563",onestore:"#e5352b",galaxy:"#1d4ed8"};
var SMS = {google:"G",apple:"◎",onestore:"1",galaxy:"S"};
// 스토어 로고: 각 스토어에 노출 중인 앱 아이콘(임베드)이 있으면 이미지, 없으면 글자 배지
function logoHtml(k){
  var ics=REAL.icons||{};
  // 같은 게임이라 스토어별 아이콘이 없으면 대표 아이콘(구글→애플→원스토어)으로 폴백
  var ic=ics[k]||ics.google||ics.apple||ics.onestore;
  return ic ? '<img class="logo-img" src="'+ic+'" alt="">'
            : '<span class="logo" style="background:'+SMC[k]+'">'+SMS[k]+'</span>';
}
// 일간: 최신 스냅샷(수집 당일)은 미완료 하루 → 기본은 직전 완료일(length-2). 라벨은 보고일(=데이터일+1).
var DAILY_LAST = Math.max(0, DATES.length-2);
var state = { mode:"daily", lang:"__DEFAULTLANG__", period:DAILY_LAST, loungeTab:null };
var SHOW_MAIL_BAR = __SHOWMAILBAR__; // 메일 수신자 바 표시(운영자용 true / 메일첨부용 false)
var GRPZH = {"공식":"官方","커뮤니티":"社区","고객센터":"客服","인증 이벤트 게시판":"认证活动板块","운영 정책":"运营政策","종료된 이벤트":"已结束活动"};
var BOARDZH = {"공지":"公告","점검&업데이트":"维护&更新","이벤트":"活动","나의 최애캐💖":"我的最爱角色💖","가입인사":"加入问候","스토어 리뷰 인증":"商店评价认证","프로필 인증":"资料认证","자유 게시판":"自由板","질문&답변":"问答","공략 & TIP":"攻略&TIP","길드원 모집":"公会招募","부족 친구 모집":"部落好友招募","연맹 친구 모집":"联盟好友招募","버그 제보":"BUG反馈","건의사항":"建议","운영정책":"运营政策","전장 소식 공유":"战场消息分享","월드보스 인증 이벤트":"世界BOSS认证活动","공략 작가 이벤트":"攻略作者活动"};
var ACTIVE_LSUM = null; // 선택 일자 기준 활성 라운지 요약 (paintBoardTabs가 참조)

function tt(){ return T[state.lang]; }
function fmt(n){ return n==null?"-":n.toLocaleString(state.lang==="zh"?"zh-CN":"ko-KR"); }
function d2(s){ return s.slice(5).replace("-","."); }
function wdOf(s){ return tt().wd[new Date(s).getUTCDay()]; }

function buildWeeks(){
  var out=[]; var first=new Date(DATES[0]); var dow=(first.getUTCDay()+6)%7;
  first.setUTCDate(first.getUTCDate()-dow);
  var lastD=new Date(DATES[DATES.length-1]);
  var cur=new Date(first);
  while(cur<=lastD){
    var mon=cur.toISOString().slice(0,10);
    var sd=new Date(cur); sd.setUTCDate(sd.getUTCDate()+6); var sun=sd.toISOString().slice(0,10);
    var idxs=[]; for(var i=0;i<DATES.length;i++){ if(DATES[i]>=mon&&DATES[i]<=sun) idxs.push(i); }
    if(idxs.length) out.push({mon:mon,sun:sun,idxs:idxs});
    cur.setUTCDate(cur.getUTCDate()+7);
  }
  return out;
}
var WEEKS = buildWeeks();

function ratingAsOf(store,upto){ var v=null; for(var i=0;i<=upto;i++){ if(REAL.stores[store].rating[i]!=null) v=REAL.stores[store].rating[i]; } return v; }
// 감성 정규화: 분류값 우선, 없으면 별점 기반
function seClass(r){ if(r.se==="긍정")return"pos"; if(r.se==="부정")return"neg"; if(r.se==="중립")return"neu";
  return r.sc>=4?"pos":r.sc<=2?"neg":"neu"; }
function slot(idxs){
  var end=Math.max.apply(null,idxs);
  var s={stores:{},total:0};
  REAL.storeList.forEach(function(k){
    var st=REAL.stores[k];
    if(!st.connected){ s.stores[k]={connected:false}; return; }
    var rev=0,free=null,fi=-1,gross=null,gi=-1;
    idxs.forEach(function(i){ rev+=st.reviews[i]||0;
      if(st.free[i]!=null&&i>fi){free=st.free[i];fi=i;} if(st.gross[i]!=null&&i>gi){gross=st.gross[i];gi=i;} });
    s.stores[k]={connected:true,reviews:rev,free:free,gross:gross,rating:ratingAsOf(k,end),
      metricsOnly:st.metricsOnly||false, totalRatings:st.totalRatings??null, downloads:st.downloads??null};
  });
  // 리뷰 취합
  var revs=[]; idxs.forEach(function(i){ revs=revs.concat(REAL.reviewsByDate[DATES[i]]||[]); });
  s.total=(s.stores.google.reviews||0)+(s.stores.apple.reviews||0);
  // 감성 카운트 (분류 기반)
  var pos=0,neu=0,neg=0; revs.forEach(function(r){ var c=seClass(r); if(c==="pos")pos++;else if(c==="neg")neg++;else neu++; });
  var tot=pos+neu+neg;
  s.posN=pos; s.neuN=neu; s.negN=neg;
  s.pct = tot?[Math.round(pos/tot*100),Math.round(neu/tot*100),0]:null; if(s.pct) s.pct[2]=100-s.pct[0]-s.pct[1];
  // 주제 집계 (+주제별 감성 우세)
  var tmap={}; revs.forEach(function(r){ var t=r.tp||"미분류"; if(!tmap[t])tmap[t]={n:0,pos:0,neg:0}; tmap[t].n++; var c=seClass(r); if(c==="pos")tmap[t].pos++;else if(c==="neg")tmap[t].neg++; });
  s.topics=Object.keys(tmap).map(function(t){ var o=tmap[t]; return {name:t,count:o.n,tone:o.neg>o.pos?"bad":o.pos>o.neg?"good":"accent"}; }).sort(function(a,b){return b.count-a.count;});
  // 주목 리뷰: 긍정 3 + 부정 2 (부정 없으면 긍정 5)
  var poss=revs.filter(function(r){return seClass(r)==="pos";}).sort(function(a,b){return b.sc-a.sc;});
  var negs=revs.filter(function(r){return seClass(r)==="neg";}).sort(function(a,b){return a.sc-b.sc;});
  var negTake=negs.slice(0,2);
  var posTake=negTake.length?poss.slice(0,3):poss.slice(0,5);
  s.notable=posTake.concat(negTake);
  return s;
}
function curIdxs(){ return state.mode==="daily"?[state.period]:WEEKS[state.period].idxs; }
function prevIdxs(){ if(state.mode==="daily") return state.period>0?[state.period-1]:null;
  return state.period>0?WEEKS[state.period-1].idxs:null; }
function periodTxt(){ if(state.mode==="daily") return d2(DATES[state.period])+" ("+wdOf(DATES[state.period])+")";
  var w=WEEKS[state.period]; return d2(w.mon)+" ~ "+d2(w.sun); }
function periodFull(){ if(state.mode==="daily") return DATES[state.period]+" ("+wdOf(DATES[state.period])+")";
  var w=WEEKS[state.period]; return w.mon+" ~ "+w.sun; }
function fullDate(s){ return s+" ("+wdOf(s)+")"; }

function rankDelta(c,p){ if(c==null||p==null) return {cls:"flat",txt:""}; var d=p-c;
  if(d>0)return{cls:"up",txt:"▲"+d}; if(d<0)return{cls:"down",txt:"▼"+(-d)}; return{cls:"flat",txt:"—"}; }
function hiDelta(c,p,dec){ if(c==null||p==null) return {cls:"flat",txt:""}; var d=+(c-p).toFixed(dec||0);
  if(d>0)return{cls:"up",txt:"▲"+(dec?d.toFixed(dec):d)}; if(d<0)return{cls:"down",txt:"▼"+(dec?Math.abs(d).toFixed(dec):Math.abs(d))}; return{cls:"flat",txt:"—"}; }
function neuDelta(c,p){ if(c==null||p==null) return {cls:"flat",txt:""}; var d=c-p;
  if(d>0)return{cls:"flat",txt:"▲"+d}; if(d<0)return{cls:"flat",txt:"▼"+(-d)}; return{cls:"flat",txt:"—"}; }
function dchip(d){ return d.txt?'<span class="delta '+d.cls+'">'+d.txt+'</span>':''; }
function esc(s){ return (s||"").replace(/</g,"&lt;"); }
// 다운로드 등 원문 값의 한국어 숫자단위 → 중국어(zh 모드)
function locDl(s){ return (state.lang==="zh"&&s)? s.replace(/천/g,"千").replace(/만/g,"万").replace(/억/g,"亿").replace(/개/g,"个") : s; }

function fdate(s){ return s? s.slice(4,6)+"."+s.slice(6,8)+" "+s.slice(8,10)+":"+s.slice(10,12) : ""; }
function feedRow(f,L,hideBoard){
  var meta='<span>'+L.loungeComment+' '+f.commentCount+'</span><span>'+L.loungeBuff+' '+f.buffCount+'</span><span>'+L.loungeRead+' '+f.readCount+'</span><span>'+fdate(f.createdDate)+'</span>';
  var board=(!hideBoard&&f.board)?'<span class="chip board">'+esc(f.board)+'</span>':'';
  var head=board?'<div class="feed-h">'+board+'</div>':'';
  return '<a class="feed" href="'+f.url+'" target="_blank" rel="noopener">'+head+'<div class="feed-t">'+esc(f.title||"(제목 없음)")+'</div><div class="feed-m">'+meta+'</div></a>';
}
// 현재 선택 기간(일간=해당일, 주간=월~일)의 KST 날짜 범위
function loungePeriod(){
  if(state.mode==="daily"){ var d=DATES[state.period]; return {start:d, end:d}; }
  var w=WEEKS[state.period]; return {start:w.mon, end:w.sun};
}
// 선택 기간에 해당하는 라운지 스냅샷 일자 (없으면 null). 주간=그 주 내 마지막 수집일.
function loungeSnapDate(){
  var bd=(REAL.lounge&&REAL.lounge.byDate)||{};
  if(state.mode==="daily"){ var d=DATES[state.period]; return bd[d]?d:null; }
  var w=WEEKS[state.period], found=null;
  for(var i=0;i<DATES.length;i++){ var x=DATES[i]; if(x>=w.mon&&x<=w.sun&&bd[x]) found=x; }
  return found;
}
// 선택 기간에 boardFeeds에서 작성된 글 수 (일자 기준 신규글)
function loungeNewInPeriod(lo, pr){
  var n=0, bf=lo.boardFeeds||{};
  for(var k in bf){ (bf[k].recent||[]).forEach(function(f){ if(f.createdKst&&f.createdKst>=pr.start&&f.createdKst<=pr.end) n++; }); }
  return n;
}
function grpLabel(g){ return state.lang==="zh" ? (GRPZH[g]||g||"") : (g||""); }
function boardLabel(n){ return state.lang==="zh" ? (BOARDZH[n]||n||"") : (n||""); }
// 게시판 탭 바 + 본문 렌더 (클릭 시 본문만 교체, 전체 재렌더 없음)
function paintBoardTabs(tabs, L){
  var bar=document.getElementById("btabs"); if(!bar) return;
  bar.innerHTML = tabs.map(function(t){
    return '<button class="btab'+(t.boardId===state.loungeTab?" on":"")+'" data-bid="'+t.boardId+'">'+esc(boardLabel(t.name))+' <em>'+t.count+'</em></button>';
  }).join("");
  bar.querySelectorAll(".btab").forEach(function(btn){
    btn.addEventListener("click", function(){ state.loungeTab=+btn.getAttribute("data-bid"); paintBoardTabs(tabs, L); });
  });
  var t = tabs.filter(function(x){return x.boardId===state.loungeTab;})[0] || tabs[0];
  var bsum=(ACTIVE_LSUM&&ACTIVE_LSUM.boards)||{};
  var s=bsum[t.boardId]; var sumTxt = s ? (s[state.lang]||s.ko||s.zh||"") : "";
  document.getElementById("btabBody").innerHTML =
    '<div class="btab-head"><h4>'+esc(boardLabel(t.name))+'</h4>'+(t.group?'<span class="grp">'+esc(grpLabel(t.group))+'</span>':'')+
      '<span class="bcnt">'+L.boardPeriodCnt.replace("%n",t.count)+'</span></div>'+
    (sumTxt?'<p class="board-sum">'+esc(sumTxt)+'</p>':'<p class="board-sum na">'+L.loungeSummaryNone+'</p>')+
    '<div class="reviews">'+t.feeds.map(function(f){return feedRow(f,L,true);}).join("")+'</div>';
}
// 일별 신규글 막대 + 누적 게시물 라인 (한 SVG, 이중 스케일). 최근 최대 21일.
function addDay(s,n){ var d=new Date(s+"T00:00:00Z"); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
// 추이 창: 일간=선택일 기준 최근 7일, 주간=해당 주(월~일 7일)
function loungeWindowDates(){
  var out=[];
  if(state.mode==="weekly"){ var w=WEEKS[state.period], d=w.mon; for(var i=0;i<7;i++){ out.push(d); d=addDay(d,1); } }
  else { var end=DATES[state.period]; for(var j=6;j>=0;j--) out.push(addDay(end,-j)); }
  return out;
}
// 일별 신규글 막대 차트(누적 라인 없음). boardFeeds 작성일로 일자별 집계. 각 막대에 값·일자·요일.
function loungeTrendChart(lo, wdates, L){
  // 일자별 신규글 수: 그날 스냅샷의 newToday(실측, recentCommunity 기준) 우선, 없으면 boardFeeds 작성일 집계(폴백).
  var bf=lo.boardFeeds||{}, byDate=(REAL.lounge&&REAL.lounge.byDate)||{};
  var counts=wdates.map(function(d){
    if(byDate[d] && byDate[d].newToday!=null) return byDate[d].newToday;
    var n=0; for(var k in bf){ (bf[k].recent||[]).forEach(function(f){ if(f.createdKst===d) n++; }); } return n;
  });
  var nmax=Math.max.apply(null, counts.concat([1]));
  var n=wdates.length, W=Math.max(n*128, 900), H=150, padB=34, padT=20, padX=16;
  var innerW=W-2*padX, innerH=H-padT-padB, slot=innerW/n, bw=Math.min(slot*0.34, 40), baseY=padT+innerH;
  var base='<line x1="'+padX+'" y1="'+baseY.toFixed(1)+'" x2="'+(W-padX).toFixed(1)+'" y2="'+baseY.toFixed(1)+'" stroke="var(--border)"/>';
  var bars=wdates.map(function(d,i){
    var v=counts[i], h=(v/nmax)*innerH, cx=padX+slot*i+slot/2, y=baseY-h;
    var rect = v>0
      ? '<rect x="'+(cx-bw/2).toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+h.toFixed(1)+'" rx="5" fill="var(--accent)"/>'
      : '<rect x="'+(cx-bw/2).toFixed(1)+'" y="'+(baseY-3).toFixed(1)+'" width="'+bw.toFixed(1)+'" height="3" rx="1.5" fill="var(--surface-3)"/>';
    var val = v>0 ? '<text x="'+cx.toFixed(1)+'" y="'+(y-6).toFixed(1)+'" text-anchor="middle" class="ct-val">'+v+'</text>'
                  : '<text x="'+cx.toFixed(1)+'" y="'+(baseY-8).toFixed(1)+'" text-anchor="middle" class="ct-val0">0</text>';
    var dt='<text x="'+cx.toFixed(1)+'" y="'+(baseY+17).toFixed(1)+'" text-anchor="middle" class="ct-date">'+d2(d)+'</text>';
    var wk='<text x="'+cx.toFixed(1)+'" y="'+(baseY+29).toFixed(1)+'" text-anchor="middle" class="ct-wd">'+wdOf(d)+'</text>';
    return rect+val+dt+wk;
  }).join("");
  return '<div class="lchart-wrap"><svg class="lchart" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="xMidYMid meet" role="img">'+base+bars+'</svg></div>';
}
// ===== 고객센터(helpdesk) 렌더 =====
function csDailyMap(){ var m={}; ((REAL.cs&&REAL.cs.daily)||[]).forEach(function(r){ m[r.date]={created:r.created||0,resolved:r.resolved||0}; }); return m; }
function csPeriodDates(){ if(state.mode==="weekly"){ var w=WEEKS[state.period], d=w.mon, o=[]; for(var i=0;i<7;i++){o.push(d);d=addDay(d,1);} return o;} return [DATES[state.period]]; }
function csPrevPeriodDates(){ if(state.mode==="weekly"){ if(state.period<1)return null; var w=WEEKS[state.period-1], d=w.mon, o=[]; for(var i=0;i<7;i++){o.push(d);d=addDay(d,1);} return o;} return state.period>0?[DATES[state.period-1]]:null; }
function csSum(dates,key){ var m=csDailyMap(),s=0; (dates||[]).forEach(function(d){ if(m[d]) s+=m[d][key]||0; }); return s; }
function csTrendChart(wdates){
  var m=csDailyMap();
  var cA=wdates.map(function(d){return (m[d]&&m[d].created)||0;});
  var cR=wdates.map(function(d){return (m[d]&&m[d].resolved)||0;});
  var nmax=Math.max.apply(null, cA.concat(cR).concat([1]));
  var n=wdates.length, W=Math.max(n*128,900), H=164, padB=34, padT=24, padX=16;
  var innerW=W-2*padX, innerH=H-padT-padB, slot=innerW/n, bw=Math.min(slot*0.2,18), baseY=padT+innerH;
  var base='<line x1="'+padX+'" y1="'+baseY.toFixed(1)+'" x2="'+(W-padX).toFixed(1)+'" y2="'+baseY.toFixed(1)+'" stroke="var(--border)"/>';
  var bars=wdates.map(function(d,i){
    var cx=padX+slot*i+slot/2;
    function bar(v,off,cls){ if(v<=0) return ''; var h=(v/nmax)*innerH, x=cx+off, y=baseY-h;
      return '<rect x="'+(x-bw/2).toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+h.toFixed(1)+'" rx="4" class="'+cls+'"/>'
        +'<text x="'+x.toFixed(1)+'" y="'+(y-5).toFixed(1)+'" text-anchor="middle" class="ct-val">'+v+'</text>'; }
    var dt='<text x="'+cx.toFixed(1)+'" y="'+(baseY+17).toFixed(1)+'" text-anchor="middle" class="ct-date">'+d2(d)+'</text>';
    var wk='<text x="'+cx.toFixed(1)+'" y="'+(baseY+29).toFixed(1)+'" text-anchor="middle" class="ct-wd">'+wdOf(d)+'</text>';
    return bar(cA[i],-bw*0.62,'csbar-new')+bar(cR[i],bw*0.62,'csbar-res')+dt+wk;
  }).join("");
  return '<div class="lchart-wrap"><svg class="lchart" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="xMidYMid meet" role="img">'+base+bars+'</svg></div>';
}
function renderCS(L){
  var sec=document.getElementById("csSection"), wrap=document.getElementById("csWrap");
  if(!REAL.cs){ if(sec) sec.style.display="none"; return; }
  sec.style.display="";
  document.getElementById("csH").textContent=L.csH;
  document.getElementById("csHint").textContent=L.csHint;
  // KPI는 섹션 취지(최근 30일)·요약과 일치하도록 30일 전체 합계. 차트는 일자별 표시.
  var created=(REAL.cs.daily||[]).reduce(function(s,d){return s+(d.created||0);},0);
  var resolved=(REAL.cs.daily||[]).reduce(function(s,d){return s+(d.resolved||0);},0);
  var byStatus=REAL.cs.byStatus||{}, byCat=REAL.cs.byCategory||{};
  var TERM={"처리완료":1,"처리불가":1};
  var pending=Object.keys(byStatus).reduce(function(s,k){return s+(TERM[k]?0:byStatus[k]);},0);
  var kpi='<div class="lounge-kpi">'+
    '<div class="lk"><span class="k">'+L.csKInquiry+'</span><span class="v"><span class="num">'+created+'</span><span class="unit">'+L.unitCnt+'</span></span></div>'+
    '<div class="lk"><span class="k">'+L.csKResolved+'</span><span class="v"><span class="num good">'+resolved+'</span><span class="unit">'+L.unitCnt+'</span></span></div>'+
    '<div class="lk"><span class="k">'+L.csKPending+'</span><span class="v"><span class="num'+(pending>0?' warn':'')+'">'+pending+'</span><span class="unit">'+L.unitCnt+'</span></span></div>'+
    '</div>';
  var sum=REAL.cs.summary, sumHtml;
  if(sum&&sum.gist){ var gist=(sum.gist[state.lang]||sum.gist.ko||"");
    var chips=(sum.topics||[]).map(function(t){ var nm=(t.name&&(t.name[state.lang]||t.name.ko))||""; var nt=(t.note&&(t.note[state.lang]||t.note.ko))||""; var tc=t.tone==="neg"?"bad":t.tone==="pos"?"good":"neu"; return '<div class="sum-topic"><span class="chip '+tc+'">'+esc(nm)+'</span><span class="sum-note">'+esc(nt)+'</span></div>'; }).join("");
    sumHtml='<div class="panel" style="margin-bottom:14px"><h3>'+L.csSummary+'</h3><p class="sub">'+L.csSummarySub.replace("%n",sum.basedOn||0)+'</p><p class="sum-gist">'+esc(gist)+'</p>'+(chips?'<div class="sum-topics">'+chips+'</div>':'')+'</div>';
  } else { sumHtml='<div class="panel" style="margin-bottom:14px"><h3>'+L.csSummary+'</h3><p class="sub na">'+L.csSummaryNone+'</p></div>'; }
  var wd=loungeWindowDates();
  var csub=(state.mode==="weekly"?L.csTrendWeek:L.csTrendDay).replace("%s",d2(wd[0])).replace("%e",d2(wd[wd.length-1]));
  var legend='<div class="cs-legend"><span class="lg"><span class="sw csbar-new"></span>'+L.csLegendNew+'</span><span class="lg"><span class="sw csbar-res"></span>'+L.csLegendResolved+'</span></div>';
  var chart='<div class="panel" style="margin-bottom:14px"><h3>'+L.csTrend+'</h3><p class="sub">'+csub+'</p>'+legend+csTrendChart(wd)+'</div>';
  var distRow=function(title,obj){ var ents=Object.keys(obj).map(function(k){return [k,obj[k]];}).sort(function(a,b){return b[1]-a[1];}); var tot=ents.reduce(function(s,e){return s+e[1];},0)||1;
    var rows=ents.map(function(e){ var pct=Math.round(e[1]/tot*100); return '<div class="cs-dist-row"><span class="cs-dist-name">'+esc(e[0])+'</span><span class="cs-dist-bar"><span class="cs-dist-fill" style="width:'+pct+'%"></span></span><span class="cs-dist-n">'+e[1]+'</span></div>'; }).join("");
    return '<div class="panel cs-dist"><h3>'+title+'</h3>'+(rows||'<p class="sub na">-</p>')+'</div>'; };
  var dist='<div class="grid-2">'+distRow(L.csByCategory,byCat)+distRow(L.csByStatus,byStatus)+'</div>';
  wrap.innerHTML=kpi+sumHtml+chart+dist;
}
function renderMail(L){
  var box=document.getElementById("mailBox"); if(!box) return;
  if(!SHOW_MAIL_BAR){ box.innerHTML=""; return; } // 메일 첨부본에선 수신자 숨김
  var list=REAL.recipients||[];
  var head='<div class="mh"><h4>'+L.mailH+'</h4>'+(list.length?'<span class="cnt">'+L.mailCount.replace("%n",list.length)+'</span>':'')+'<span class="note">'+L.mailNote+'</span></div>';
  var body=list.length
    ? '<div class="mail-list">'+list.map(function(e){var lg=(e.lang==="zh"?"中文":"한국어");return '<span class="mail-chip">'+esc(e.email)+'<span class="mail-lang'+(e.lang==="zh"?" zh":"")+'">'+lg+'</span></span>';}).join("")+'</div>'
    : '<div class="mail-empty">'+L.mailNone+'</div>';
  box.innerHTML=head+body;
}
function renderLounge(L){
  var hint=document.getElementById("loungeHint"), wrap=document.getElementById("loungeWrap");
  if(!REAL.lounge){ hint.textContent=L.off; wrap.innerHTML='<div class="panel off"><div class="off-msg">'+L.loungeMsg+'</div></div>'; return; }
  var lo=REAL.lounge.latest, ser=REAL.lounge.series||[], byDate=REAL.lounge.byDate||{};
  var pr=loungePeriod();
  // 선택 일자 기준 스냅샷 (누적/요약). 없으면 최신 스냅샷으로 폴백(명시 표기).
  var snapDate=loungeSnapDate();
  var snap=snapDate?byDate[snapDate]:null;
  var fromLatest=!(snap&&snap.summary);            // 요약을 최신으로 대체했는지
  var actSum=(snap&&snap.summary)?snap.summary:lo.summary; ACTIVE_LSUM=actSum;
  hint.textContent = L.loungeBasis.replace("%d",periodTxt())+" · "+L.loungeBoards.replace("%n",(lo.boards||[]).length)+(fromLatest?(" · "+L.loungeFromLatest.replace("%d",d2(lo.date))):"");
  // KPI — 누적 게시물(스냅샷 기준) · 신규글(선택 기간에 작성된 글)
  var postsVal = snap?snap.totalPosts:lo.totalPosts;
  var sIdx=-1; for(var si=0;si<ser.length;si++){ if(ser[si].date===snapDate) sIdx=si; }
  var prevTot = sIdx>0 ? ser[sIdx-1].totalPosts : null;
  var postDelta = snap?neuDelta(postsVal,prevTot):{cls:"flat",txt:""};
  var newCount = loungeNewInPeriod(lo, pr);
  var newLbl = state.mode==="daily"?L.loungeKpiNew:L.loungeKpiNewWeek;
  var postsCard = snap
    ? '<span class="num">'+fmt(postsVal)+'</span><span class="unit">'+L.unitCnt+'</span>'+dchip(postDelta)
    : '<span class="num na">'+fmt(postsVal)+'</span><span class="unit">'+L.unitCnt+'</span>';
  var kpi='<div class="lounge-kpi">'+
    '<div class="lk"><span class="k">'+L.loungeKpiPosts+'</span><span class="v">'+postsCard+'</span>'+(snap?"":'<span class="sub">'+L.loungeFromLatest.replace("%d",d2(lo.date))+'</span>')+'</div>'+
    '<div class="lk"><span class="k">'+newLbl+'</span><span class="v"><span class="num good">'+newCount+'</span><span class="unit">'+L.unitCnt+'</span></span></div>'+
    '</div>';
  // 라운지 여론 요약 (AI) — 선택 일자 스냅샷 요약, 없으면 최신(명시)
  var sumHtml='';
  if(actSum && actSum.gist){
    var g=actSum.gist; var gist=(g[state.lang]||g.ko||g.zh||'');
    var chips=(actSum.topics||[]).map(function(t){
      var nm=(t.name&&(t.name[state.lang]||t.name.ko))||''; var nt=(t.note&&(t.note[state.lang]||t.note.ko))||'';
      var cls=t.tone==='pos'?'pos':(t.tone==='neg'?'neg':'neu');
      return '<div class="sum-topic"><span class="chip '+cls+'">'+esc(nm)+'</span><span class="sum-note">'+esc(nt)+'</span></div>';
    }).join("");
    var sub = fromLatest ? L.loungeFromLatest.replace("%d",d2(lo.date)) : L.loungeSummarySub.replace("%n",actSum.basedOn||0);
    sumHtml='<div class="panel" style="margin-bottom:14px"><h3>'+L.loungeSummary+'</h3><p class="sub">'+sub+'</p>'+
      '<p class="sum-gist">'+esc(gist)+'</p>'+(chips?'<div class="sum-topics">'+chips+'</div>':'')+'</div>';
  }
  // 진행 이벤트 — 선택한 기간(일간=해당일, 주간=월~일)에 진행 중이던 이벤트를 표기
  // (start/end 로 기간 겹침 판정. 배지는 실제 최신일 기준 진행중/종료 표시)
  var evHtml='';
  var allEv=(actSum&&actSum.events)||[];
  if(allEv.length){
    var TODAY=DATES[DATES.length-1];
    var evs=allEv.filter(function(e){ return e.start && e.end && e.start<=pr.end && e.end>=pr.start; })
      .sort(function(a,b){ return (b.start||"").localeCompare(a.start||""); });
    var evBody = evs.length
      ? '<div class="events">'+evs.map(function(e){
          var ti=(e.title&&(e.title[state.lang]||e.title.ko))||''; var pe=(e.period&&(e.period[state.lang]||e.period.ko))||''; var co=(e.content&&(e.content[state.lang]||e.content.ko))||'';
          var live=(e.end>=TODAY); var badge=live?'<span class="ev-badge">'+L.loungeEventOngoing+'</span>':'<span class="ev-badge ended">'+L.loungeEventEnded+'</span>';
          return '<a class="event" href="'+e.url+'" target="_blank" rel="noopener"><div class="ev-top">'+badge+(pe?'<span class="ev-period">'+esc(pe)+'</span>':'')+'</div><div class="ev-title">'+esc(ti)+'</div>'+(co?'<div class="ev-content">'+esc(co)+'</div>':'')+'</a>';
        }).join("")+'</div>'
      : '<div class="empty">'+L.loungeEventNone+'</div>';
    evHtml='<div class="panel" style="margin-bottom:14px"><h3>'+L.loungeEventsH+'</h3><p class="sub">'+L.loungeEventsHint.replace("%n",evs.length)+'</p>'+evBody+'</div>';
  }
  // 추이 차트 패널 (일별 신규글 막대 + 누적 게시물 라인)
  var wdates=loungeWindowDates();
  var trendSub=(state.mode==="weekly"?L.loungeTrendWeek:L.loungeTrendDay).replace("%s",d2(wdates[0])).replace("%e",d2(wdates[wdates.length-1]));
  var trendHtml='<div class="panel" style="margin-bottom:14px"><h3>'+L.loungeTrend+'</h3><p class="sub">'+trendSub+'</p>'+
    loungeTrendChart(lo, wdates, L)+'</div>';
  // ── 게시판별 글 (원래 기획: 메뉴=게시판 · 클릭 시 그 분류 글 요약) ──
  // 탭 = 현재 선택 기간(일간/주간)에 새 글이 올라온 게시판만. 신규글 없으면 제외.
  var bmap=lo.boardFeeds||{};
  var tabs=[];
  (lo.boards||[]).forEach(function(bd){
    var bf=bmap[bd.boardId]; if(!bf) return;
    var pf=(bf.recent||[]).filter(function(f){ return f.createdKst && f.createdKst>=pr.start && f.createdKst<=pr.end; })
      .sort(function(a,b){ return (b.createdDate||"").localeCompare(a.createdDate||""); })
      .slice(0,5); // 게시판별 글 최대 5개
    if(pf.length) tabs.push({ boardId:bd.boardId, name:bd.name, group:bd.group, feeds:pf, count:pf.length });
  });
  var boardsHtml;
  if(!tabs.length){
    boardsHtml='<div class="panel"><div class="bhead"><h3>'+L.loungeBoardsH+'</h3><span class="sub">'+L.loungeBoardsHint+'</span></div><div class="empty">'+L.loungeBoardNone+'</div></div>';
  } else {
    if(!tabs.some(function(t){return t.boardId===state.loungeTab;})) state.loungeTab=tabs[0].boardId;
    boardsHtml='<div class="panel"><div class="bhead"><h3>'+L.loungeBoardsH+'</h3><span class="sub">'+L.loungeBoardsHint+'</span></div><div class="btabs" id="btabs"></div><div id="btabBody"></div></div>';
  }
  wrap.innerHTML = kpi + trendHtml + evHtml + sumHtml + boardsHtml;
  if(tabs.length) paintBoardTabs(tabs, L);
}

function render(){
  var L=tt(); var idxs=curIdxs(); var pv=prevIdxs();
  var cur=slot(idxs); var prev=pv?slot(pv):null;
  document.documentElement.lang=state.lang;

  document.getElementById("eyebrow").textContent = state.mode==="daily"?L.reportDaily:L.reportWeekly;
  var gName = state.lang==="zh" ? REAL.projectNameZh : REAL.projectName;
  document.getElementById("title").textContent = L.dash+" · "+gName;
  document.getElementById("cat").textContent = L.basis+" · "+L.country+": "+REAL.country;
  if(state.mode==="daily"){
    var dataD=DATES[state.period], colD=DATES[state.period+1];
    document.getElementById("hlBasis").innerHTML =
      '<span class="lbl">'+L.hlDataBasis+'</span><span class="val">'+fullDate(dataD)+'</span>'+
      (colD?'<span class="dot">·</span><span class="lbl sub">'+L.hlCollected+'</span><span class="val sub">'+fullDate(colD)+'</span>':'');
  } else {
    document.getElementById("hlBasis").innerHTML = '<span class="lbl">'+L.hlBasisWeek+'</span><span class="val">'+periodFull()+'</span>';
  }
  document.getElementById("printMeta").textContent = gName+" · "+periodTxt()+" "+(state.mode==="daily"?L.reportDailyDoc:L.reportWeeklyDoc);
  document.getElementById("mDaily").textContent=L.daily; document.getElementById("mWeekly").textContent=L.weekly;
  document.getElementById("periodLabel").textContent = state.mode==="daily"?L.periodDay:L.periodWeek;
  document.getElementById("langLabel").textContent=L.lang;
  document.getElementById("lang").value=state.lang;
  document.getElementById("pdfTxt").textContent=L.pdf;
  var isLatest = state.mode==="daily"?(state.period===DAILY_LAST):(state.period===WEEKS.length-1);
  var lb=document.getElementById("latestBadge"); lb.textContent=L.latest; lb.classList.toggle("hide",!isLatest);
  document.getElementById("storeH").textContent=L.storeH; document.getElementById("storeHint").textContent=L.storeHint;
  document.getElementById("rvH").textContent=L.rvH; document.getElementById("rvHint").textContent=L.rvHint;
  document.getElementById("sentiH").textContent=L.sentiH; document.getElementById("topicsTitle").textContent=L.topicsTitle;
  document.getElementById("notableH").textContent=L.notableH;
  document.getElementById("notableSub").textContent=L.notableSub.replace("%p",cur.posN).replace("%n",cur.negN);
  document.getElementById("loungeH").textContent=L.loungeH;
  renderLounge(L);
  renderCS(L);
  renderMail(L);
  document.getElementById("footR").textContent=L.footR;

  var g=cur.stores.google,a=cur.stores.apple,pg=prev?prev.stores.google:null,pa=prev?prev.stores.apple:null;
  var rk=function(v){ return v==null?'<span class="num na">'+L.noRank+'</span>':'<span class="num">'+v+'</span><span class="unit">'+L.unitRank+'</span>'; };
  var pills=[
    {k:L.kGGross, html:rk(g.gross), d:rankDelta(g.gross,pg?pg.gross:null)},
    {k:L.kAGross, html:rk(a.gross), d:rankDelta(a.gross,pa?pa.gross:null)},
    {k:L.kNew, html:'<span class="num">'+cur.total+'</span><span class="unit">'+L.unitCnt+'</span>', d:neuDelta(cur.total,prev?prev.total:null)},
    {k:L.kPos, html: cur.pct?'<span class="num good">'+cur.pct[0]+'</span><span class="unit">%</span>':'<span class="num na">-</span>', sub:cur.pct?(L.negP+" "+cur.pct[2]+"%"):"", d:{cls:"flat",txt:""}},
    {k:L.kGRate, html: g.rating!=null?'<span class="num small">★ '+g.rating.toFixed(2)+'</span>':'<span class="num na">'+L.noRate+'</span>', sub:L.cum+" "+fmt(REAL.totals.google.totalRatings), d:{cls:"flat",txt:""}},
  ];
  document.getElementById("hlStrip").innerHTML = pills.map(function(p){
    return '<div class="hl"><span class="k">'+p.k+'</span><span class="v">'+p.html+dchip(p.d)+'</span>'+(p.sub?'<span class="sub">'+p.sub+'</span>':'')+'</div>';
  }).join("");

  document.getElementById("stores").innerHTML = REAL.storeList.map(function(k){
    var st=cur.stores[k], ps=prev?prev.stores[k]:null;
    if(!st.connected) return '<div class="card off"><div class="card-h">'+logoHtml(k)+'<span class="name">'+L.store[k]+'</span><span class="badge-off">'+L.off+'</span></div><div class="off-msg">'+L.offDesc+'</div></div>';
    var fd=rankDelta(st.free,ps?ps.free:null),gd2=rankDelta(st.gross,ps?ps.gross:null),nd=neuDelta(st.reviews,ps?ps.reviews:null),ad=hiDelta(st.rating,ps?ps.rating:null,2);
    var cell=function(lbl,v,d){ return '<div class="metric"><span class="k">'+lbl+'</span><span class="v">'+(v==null?'<span class="num na">'+L.noRank+'</span>':'<span class="num">'+v+'</span><span class="unit">'+L.unitRank+'</span>'+dchip(d))+'</span></div>'; };
    var rate='<div class="metric"><span class="k">'+L.cumRate+'</span><span class="v">'+(st.rating==null?'<span class="num na">'+L.noRate+'</span>':'<span class="num">'+st.rating.toFixed(2)+'</span><span class="unit">★</span>'+dchip(ad))+'</span></div>';
    if(st.metricsOnly){
      var exK = st.downloads!=null?L.downloads:L.totalRatings;
      var exV = st.downloads!=null?('<span class="num" style="font-size:16px">'+locDl(st.downloads)+'</span>')
        : (st.totalRatings!=null?('<span class="num">'+st.totalRatings+'</span><span class="unit">'+L.unitCnt+'</span>'):'<span class="num na">-</span>');
      var exCell='<div class="metric"><span class="k">'+exK+'</span><span class="v">'+exV+'</span></div>';
      return '<div class="card"><div class="card-h">'+logoHtml(k)+'<span class="name">'+L.store[k]+'</span><span class="badge-off">'+L.metricsBadge+'</span></div><div class="metrics">'+
        cell(L.rFree,st.free,fd)+cell(L.rGross,st.gross,gd2)+exCell+rate+'</div><div class="card-note">'+L.metricsNote+'</div></div>';
    }
    var pts=REAL.stores[k].gross.filter(function(v){return v!=null;}).length;
    var note = pts<2 ? L.trendAcc : L.trendN.replace("%d",pts);
    return '<div class="card"><div class="card-h">'+logoHtml(k)+'<span class="name">'+L.store[k]+'</span></div><div class="metrics">'+
      cell(L.rFree,st.free,fd)+cell(L.rGross,st.gross,gd2)+
      '<div class="metric"><span class="k">'+L.newR+'</span><span class="v"><span class="num">'+(st.reviews||0)+'</span><span class="unit">'+L.unitCnt+'</span>'+dchip(nd)+'</span></div>'+
      rate+'</div><div class="card-note">'+note+'</div></div>';
  }).join("");

  var subTpl = state.mode==="daily"?L.subDay:L.subWeek;
  document.getElementById("reviewSub").textContent = subTpl.replace("%d",periodTxt()).replace("%n",cur.total);
  if(cur.pct){
    document.getElementById("sentiBar").innerHTML='<span class="pos" style="width:'+cur.pct[0]+'%"></span><span class="neu" style="width:'+cur.pct[1]+'%"></span><span class="neg" style="width:'+cur.pct[2]+'%"></span>';
    document.getElementById("sentiLegend").innerHTML=
      '<span class="li"><span class="dot" style="background:var(--good)"></span>'+L.pos+' <span class="mono">'+cur.pct[0]+'%</span></span>'+
      '<span class="li"><span class="dot" style="background:var(--neu)"></span>'+L.neu+' <span class="mono">'+cur.pct[1]+'%</span></span>'+
      '<span class="li"><span class="dot" style="background:var(--bad)"></span>'+L.neg+' <span class="mono">'+cur.pct[2]+'%</span></span>';
  } else { document.getElementById("sentiBar").innerHTML=''; document.getElementById("sentiLegend").innerHTML='<span class="empty">'+L.noNew+'</span>'; }

  // 주제별 언급 바
  var tcolor={good:"var(--good)",bad:"var(--bad)",accent:"var(--accent)"};
  var tmax=cur.topics.length?cur.topics[0].count:1;
  document.getElementById("topics").innerHTML = cur.topics.length ? cur.topics.map(function(t){
    return '<div class="topic"><span class="tn">'+(L.topics[t.name]||t.name)+'</span>'+
      '<span class="track"><span class="fill" style="width:'+Math.round(t.count/tmax*100)+'%;background:'+tcolor[t.tone]+'"></span></span>'+
      '<span class="tc">'+t.count+'</span></div>';
  }).join("") : '';

  var lab={pos:L.pos,neg:L.neg,neu:L.neu};
  document.getElementById("reviews").innerHTML = cur.notable.length ? cur.notable.map(function(r){
    var sc=r.sc, cl=seClass(r);
    var full="★".repeat(sc),empty="☆".repeat(5-sc);
    var col=sc<=2?'var(--bad)':sc>=4?'var(--good)':'var(--warn)';
    var topicChip = r.tp?'<span class="chip topic">'+(L.topics[r.tp]||r.tp)+'</span>':'';
    return '<div class="rv"><div class="rv-h"><span class="stars" style="color:'+col+'">'+full+empty+'</span><span class="chip store">'+L.store[r.sk]+'</span><span class="chip '+cl+'">'+lab[cl]+'</span>'+topicChip+'</div><p>'+esc(r.x)+'</p></div>';
  }).join("") : '<div class="empty">'+L.noNew+'</div>';

  document.getElementById("src").textContent = L.src.replace("%t",REAL.lastRun?REAL.lastRun.slice(0,16).replace("T"," "):"-").replace("%n",DATES.length);
}

function fillPeriod(){
  var sel=document.getElementById("period"); var L=tt();
  if(state.mode==="daily"){
    // 값=데이터 인덱스 i, 라벨=보고일(=DATES[i+1]). 마지막(미완료 당일)은 보고 대상 제외.
    var op=[]; for(var i=0;i<DATES.length-1;i++){ var rep=DATES[i+1]; op.push('<option value="'+i+'">'+d2(rep)+" ("+tt().wd[new Date(rep).getUTCDay()]+")</option>"); }
    sel.innerHTML=op.join("");
  } else {
    sel.innerHTML=WEEKS.map(function(w,i){ return '<option value="'+i+'">'+d2(w.mon)+" ~ "+d2(w.sun)+"</option>"; }).join("");
  }
  sel.value=state.period;
}
function setMode(m){ if(state.mode===m) return; state.mode=m;
  state.period = m==="daily"?DAILY_LAST:WEEKS.length-1;
  document.getElementById("mDaily").classList.toggle("on",m==="daily");
  document.getElementById("mWeekly").classList.toggle("on",m==="weekly");
  fillPeriod(); render(); }

document.getElementById("modeSeg").addEventListener("click",function(e){ var b=e.target.closest("button"); if(b) setMode(b.dataset.m); });
document.getElementById("period").addEventListener("change",function(e){ state.period=+e.target.value; render(); });
document.getElementById("lang").addEventListener("change",function(e){ state.lang=e.target.value; fillPeriod(); render(); });
document.getElementById("pdfBtn").addEventListener("click",function(){ window.print(); });

fillPeriod(); render();
</script>`;
}

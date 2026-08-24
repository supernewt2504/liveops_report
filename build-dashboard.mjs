// data.json → 대시보드 HTML 생성 (실데이터 임베드 · 일간/주간 · 한/중)
// 사용법: node build-dashboard.mjs   → dashboard.html 생성
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const db = JSON.parse(readFileSync(join(DIR, 'data.json'), 'utf8'));
const projId = Object.keys(db.projects)[0];
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
const REAL = {
  projectName: proj.name, country: (db.meta?.country || 'kr').toUpperCase(), lastRun: db.meta?.lastRun || '',
  dates, stores, reviewsByDate,
  totals: {
    google: { overallScore: last.google?.overallScore ?? null, totalRatings: last.google?.totalRatings ?? null },
    apple: { overallScore: last.apple?.overallScore ?? null, totalRatings: last.apple?.totalRatings ?? null },
  },
};

writeFileSync(join(DIR, 'dashboard.html'), TEMPLATE(JSON.stringify(REAL)));
console.log(`✓ dashboard.html 생성 (일자 ${dates.length}개, 최신 ${dates[dates.length - 1]})`);

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
  .hl-strip{display:grid;grid-template-columns:repeat(5,1fr)}
  @media(max-width:760px){.hl-strip{grid-template-columns:repeat(2,1fr)}}
  @media(max-width:420px){.hl-strip{grid-template-columns:1fr}}
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
  footer{margin-top:18px;padding-top:16px;border-top:1px solid var(--border);font-size:11.5px;color:var(--ink-3);display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}
  .mono-note{font-family:"IBM Plex Mono","Noto Sans SC",monospace}
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
  <div class="summary"><div class="hl-strip" id="hlStrip"></div></div>
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
    <div class="panel off"><div class="off-msg" id="loungeMsg"></div></div>
  </section>
  <footer><span class="mono-note" id="src"></span><span id="footR"></span></footer>
</div>

<script>
var REAL = ${dataJson};
var DATES = REAL.dates;
var T = {
  ko:{ reportDaily:"Daily Operations Report", reportWeekly:"Weekly Operations Report",
    dash:"운영 대시보드", basis:"순위 기준: 게임 전체", country:"국가", daily:"일간", weekly:"주간",
    periodDay:"보고 일자", periodWeek:"보고 주차", lang:"언어", latest:"최신", pdf:"PDF 저장",
    reportDailyDoc:"일간 운영보고서", reportWeeklyDoc:"주간 운영보고서",
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
    loungeH:"네이버 라운지", loungeHint:"미연동",
    loungeMsg:"🔌 아직 연동되지 않았습니다. 방문자수(관리자 통계)·게시물 요약·진행 이벤트는 이후 단계에서 연동됩니다.",
    unitRank:"위", unitCnt:"건", subDay:"%d 신규 리뷰 %n건 기준", subWeek:"%d 주간 신규 리뷰 %n건 기준",
    src:"◈ 실데이터 · 최근 수집 %t · 일자 %n개", footR:"구글 · 애플 연동 · 원스토어/갤럭시/라운지 예정",
    store:{google:"구글플레이",apple:"애플 앱스토어",onestore:"원스토어",galaxy:"갤럭시스토어"},
    wd:["일","월","화","수","목","금","토"] },
  zh:{ reportDaily:"日运营报告", reportWeekly:"周运营报告",
    dash:"运营仪表板", basis:"排名基准: 游戏总榜", country:"国家", daily:"日报", weekly:"周报",
    periodDay:"报告日期", periodWeek:"报告周", lang:"语言", latest:"最新", pdf:"PDF 保存",
    reportDailyDoc:"日运营报告", reportWeeklyDoc:"周运营报告",
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
    loungeH:"NAVER Lounge", loungeHint:"未接入",
    loungeMsg:"🔌 尚未接入。访问量(管理后台统计)·帖子摘要·进行中活动将在后续阶段接入。",
    unitRank:"名", unitCnt:"条", subDay:"%d 新增评论 共%n条", subWeek:"%d 周新增评论 共%n条",
    src:"◈ 实时数据 · 最近采集 %t · 天数 %n", footR:"已接入 Google · Apple · ONE Store/Galaxy/Lounge 待接入",
    store:{google:"Google Play",apple:"App Store",onestore:"ONE Store",galaxy:"Galaxy Store"},
    wd:["周日","周一","周二","周三","周四","周五","周六"] }
};
var SMC = {google:"#00875a",apple:"#4b5563",onestore:"#e5352b",galaxy:"#1d4ed8"};
var SMS = {google:"G",apple:"◎",onestore:"1",galaxy:"S"};
var state = { mode:"daily", lang:"ko", period:DATES.length-1 };

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
  ["google","apple","onestore","galaxy"].forEach(function(k){
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

function rankDelta(c,p){ if(c==null||p==null) return {cls:"flat",txt:""}; var d=p-c;
  if(d>0)return{cls:"up",txt:"▲"+d}; if(d<0)return{cls:"down",txt:"▼"+(-d)}; return{cls:"flat",txt:"—"}; }
function hiDelta(c,p,dec){ if(c==null||p==null) return {cls:"flat",txt:""}; var d=+(c-p).toFixed(dec||0);
  if(d>0)return{cls:"up",txt:"▲"+(dec?d.toFixed(dec):d)}; if(d<0)return{cls:"down",txt:"▼"+(dec?Math.abs(d).toFixed(dec):Math.abs(d))}; return{cls:"flat",txt:"—"}; }
function neuDelta(c,p){ if(c==null||p==null) return {cls:"flat",txt:""}; var d=c-p;
  if(d>0)return{cls:"flat",txt:"▲"+d}; if(d<0)return{cls:"flat",txt:"▼"+(-d)}; return{cls:"flat",txt:"—"}; }
function dchip(d){ return d.txt?'<span class="delta '+d.cls+'">'+d.txt+'</span>':''; }
function esc(s){ return (s||"").replace(/</g,"&lt;"); }

function render(){
  var L=tt(); var idxs=curIdxs(); var pv=prevIdxs();
  var cur=slot(idxs); var prev=pv?slot(pv):null;
  document.documentElement.lang=state.lang;

  document.getElementById("eyebrow").textContent = state.mode==="daily"?L.reportDaily:L.reportWeekly;
  document.getElementById("title").textContent = L.dash+" · "+REAL.projectName;
  document.getElementById("cat").textContent = L.basis+" · "+L.country+": "+REAL.country;
  document.getElementById("printMeta").textContent = REAL.projectName+" · "+periodTxt()+" "+(state.mode==="daily"?L.reportDailyDoc:L.reportWeeklyDoc);
  document.getElementById("mDaily").textContent=L.daily; document.getElementById("mWeekly").textContent=L.weekly;
  document.getElementById("periodLabel").textContent = state.mode==="daily"?L.periodDay:L.periodWeek;
  document.getElementById("langLabel").textContent=L.lang;
  document.getElementById("pdfTxt").textContent=L.pdf;
  var isLatest = state.mode==="daily"?(state.period===DATES.length-1):(state.period===WEEKS.length-1);
  var lb=document.getElementById("latestBadge"); lb.textContent=L.latest; lb.classList.toggle("hide",!isLatest);
  document.getElementById("storeH").textContent=L.storeH; document.getElementById("storeHint").textContent=L.storeHint;
  document.getElementById("rvH").textContent=L.rvH; document.getElementById("rvHint").textContent=L.rvHint;
  document.getElementById("sentiH").textContent=L.sentiH; document.getElementById("topicsTitle").textContent=L.topicsTitle;
  document.getElementById("notableH").textContent=L.notableH;
  document.getElementById("notableSub").textContent=L.notableSub.replace("%p",cur.posN).replace("%n",cur.negN);
  document.getElementById("loungeH").textContent=L.loungeH; document.getElementById("loungeHint").textContent=L.loungeHint;
  document.getElementById("loungeMsg").innerHTML=L.loungeMsg; document.getElementById("footR").textContent=L.footR;

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

  document.getElementById("stores").innerHTML = ["google","apple","onestore","galaxy"].map(function(k){
    var st=cur.stores[k], ps=prev?prev.stores[k]:null;
    if(!st.connected) return '<div class="card off"><div class="card-h"><span class="logo" style="background:'+SMC[k]+'">'+SMS[k]+'</span><span class="name">'+L.store[k]+'</span><span class="badge-off">'+L.off+'</span></div><div class="off-msg">'+L.offDesc+'</div></div>';
    var fd=rankDelta(st.free,ps?ps.free:null),gd2=rankDelta(st.gross,ps?ps.gross:null),nd=neuDelta(st.reviews,ps?ps.reviews:null),ad=hiDelta(st.rating,ps?ps.rating:null,2);
    var cell=function(lbl,v,d){ return '<div class="metric"><span class="k">'+lbl+'</span><span class="v">'+(v==null?'<span class="num na">'+L.noRank+'</span>':'<span class="num">'+v+'</span><span class="unit">'+L.unitRank+'</span>'+dchip(d))+'</span></div>'; };
    var rate='<div class="metric"><span class="k">'+L.cumRate+'</span><span class="v">'+(st.rating==null?'<span class="num na">'+L.noRate+'</span>':'<span class="num">'+st.rating.toFixed(2)+'</span><span class="unit">★</span>'+dchip(ad))+'</span></div>';
    if(st.metricsOnly){
      var exK = st.downloads!=null?L.downloads:L.totalRatings;
      var exV = st.downloads!=null?('<span class="num" style="font-size:16px">'+st.downloads+'</span>')
        : (st.totalRatings!=null?('<span class="num">'+st.totalRatings+'</span><span class="unit">'+L.unitCnt+'</span>'):'<span class="num na">-</span>');
      var exCell='<div class="metric"><span class="k">'+exK+'</span><span class="v">'+exV+'</span></div>';
      return '<div class="card"><div class="card-h"><span class="logo" style="background:'+SMC[k]+'">'+SMS[k]+'</span><span class="name">'+L.store[k]+'</span><span class="badge-off">'+L.metricsBadge+'</span></div><div class="metrics">'+
        cell(L.rFree,st.free,fd)+cell(L.rGross,st.gross,gd2)+exCell+rate+'</div><div class="card-note">'+L.metricsNote+'</div></div>';
    }
    var pts=REAL.stores[k].gross.filter(function(v){return v!=null;}).length;
    var note = pts<2 ? L.trendAcc : L.trendN.replace("%d",pts);
    return '<div class="card"><div class="card-h"><span class="logo" style="background:'+SMC[k]+'">'+SMS[k]+'</span><span class="name">'+L.store[k]+'</span></div><div class="metrics">'+
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
    sel.innerHTML=DATES.map(function(d,i){ return '<option value="'+i+'">'+d2(d)+" ("+tt().wd[new Date(d).getUTCDay()]+")</option>"; }).join("");
  } else {
    sel.innerHTML=WEEKS.map(function(w,i){ return '<option value="'+i+'">'+d2(w.mon)+" ~ "+d2(w.sun)+"</option>"; }).join("");
  }
  sel.value=state.period;
}
function setMode(m){ if(state.mode===m) return; state.mode=m;
  state.period = m==="daily"?DATES.length-1:WEEKS.length-1;
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

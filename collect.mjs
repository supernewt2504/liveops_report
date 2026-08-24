// 게임 운영 대시보드 - 구글/애플 데이터 수집기
// 사용법: node collect.mjs   (매일 1회 실행 → data.json 에 당일 스냅샷 누적)
import gplay from 'google-play-scraper';
import store from 'app-store-scraper';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf8'));
const COUNTRY = cfg.country || 'kr';
const LANG = cfg.lang || 'ko';

// ---- KST 기준 날짜 문자열 (YYYY-MM-DD) ----
function kstDate(d = new Date()) {
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
const TODAY = kstDate();

// ---- 순위 조회: 지정 카테고리 무료/매출 차트에서 위치 찾기 (없으면 null=차트 외) ----
async function googleRank(appId, collection, category) {
  try {
    const list = await gplay.list({ collection, category, country: COUNTRY, num: 200 });
    const i = list.findIndex(a => a.appId === appId);
    return i >= 0 ? i + 1 : null;
  } catch (e) { console.warn('  ! google rank 실패:', e.message); return null; }
}
async function appleRank(appId, collection, category) {
  try {
    const list = await store.list({ collection, category, country: COUNTRY, num: 200 });
    const i = list.findIndex(a => String(a.id) === String(appId));
    return i >= 0 ? i + 1 : null;
  } catch (e) { console.warn('  ! apple rank 실패:', e.message); return null; }
}

// ---- 리뷰를 날짜별(KST)로 버킷팅: 한 번 실행으로 최근 며칠치를 채움 ----
function bucketReviews(reviews) {
  const byDate = {};
  for (const r of reviews) {
    if (!r.date) continue;
    const d = kstDate(new Date(r.date));
    (byDate[d] ??= []).push(r);
  }
  const out = {};
  for (const [d, list] of Object.entries(byDate)) {
    out[d] = {
      newCount: list.length,
      avgScore: +(list.reduce((a, r) => a + r.score, 0) / list.length).toFixed(2),
      reviews: list.slice(0, 100).map(r => ({
        id: r.id, score: r.score, date: r.date, text: r.text,
        reply: r.replyText || null,
        sentiment: null, topic: null, // 감성/주제는 3단계(LLM 분류)에서 채움
      })),
    };
  }
  return out;
}

async function collectGoogle(appId, categoryName) {
  const category = gplay.category[categoryName] || gplay.category.GAME;
  const app = await gplay.app({ appId, country: COUNTRY, lang: LANG });
  const rv = await gplay.reviews({ appId, country: COUNTRY, lang: LANG, sort: gplay.sort.NEWEST, num: cfg.reviewFetch?.googleNum || 150 });
  const norm = rv.data.map(r => ({ id: r.id, score: r.score, date: r.date, text: r.text, replyText: r.replyText }));
  const [freeRank, grossRank] = await Promise.all([
    googleRank(appId, gplay.collection.TOP_FREE, category),
    googleRank(appId, gplay.collection.GROSSING, category),
  ]);
  return {
    overallScore: +app.score.toFixed(2), totalRatings: app.ratings,
    rankFree: freeRank, rankGrossing: grossRank,
    reviewsByDate: bucketReviews(norm),
  };
}

async function collectApple(appId, categoryName) {
  const category = store.category[categoryName] || store.category.GAMES;
  const app = await store.app({ id: appId, country: COUNTRY });
  const pages = cfg.reviewFetch?.applePages || 4;
  let all = [];
  for (let p = 1; p <= pages; p++) {
    try {
      const rv = await store.reviews({ id: appId, country: COUNTRY, sort: store.sort.RECENT, page: p });
      all = all.concat(rv);
      if (rv.length < 50) break;
    } catch (e) { console.warn('  ! apple reviews page', p, '실패:', e.message); break; }
  }
  // 애플은 날짜가 updated 필드
  const norm = all.map(r => ({ id: r.id, score: r.score, date: r.updated, text: r.text, replyText: null }));
  const [freeRank, grossRank] = await Promise.all([
    appleRank(appId, store.collection.TOP_FREE_IOS, category),
    appleRank(appId, store.collection.TOP_GROSSING_IOS, category),
  ]);
  return {
    overallScore: +app.score.toFixed(2), totalRatings: app.reviews,
    rankFree: freeRank, rankGrossing: grossRank,
    reviewsByDate: bucketReviews(norm),
  };
}

// ---- 원스토어: 상품 페이지에서 평점·다운로드 파싱 (지표 위주, 리뷰 미수집) ----
const UA_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const UA_MOBILE = 'Mozilla/5.0 (Linux; Android 13; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36';
async function collectOnestore(pid) {
  const res = await fetch(`https://m.onestore.co.kr/v2/ko-kr/app/${pid}`, { headers: { 'User-Agent': UA_DESKTOP } });
  const html = await res.text();
  const rating = html.match(/meta">([\d.]+)<\/span><span class="[^"]*caption">평점/);
  const dl = html.match(/meta">([^<]+)<\/span><span class="[^"]*caption">다운로드/);
  return { overallScore: rating ? parseFloat(rating[1]) : null, downloads: dl ? dl[1].trim() : null };
}
// ---- 갤럭시 전체 게임 '인기' 차트 순위 (ods.as chartProductList2Notc, APK 분석으로 도출) ----
// 인기=alignOrder bestselling / chartType GAMES / status 0(전체) / gameIncYn Y / mcc 450(KR)
// (최고매출=topGrossing 은 웹 게이트웨이가 인기와 동일 반환 → 웹 자동화 불가, 수동/에뮬)
function galaxyChartPayload() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<SamsungProtocol networkType="0" version2="0" lang="EN" openApiVersion="28" deviceModel="SM-G998B" mcc="450" mnc="00" csc="CPW" odcVersion="9.9.30.9" version="6.5" filter="1" odcType="01" systemId="1" sessionId="s" logId="X" userMode="0">
<request name="chartProductList2Notc" id="2223" numParam="9" transactionId="t">
<param name="imgWidth">135</param><param name="imgHeight">135</param>
<param name="startNum">1</param><param name="endNum">500</param>
<param name="contentType">all</param><param name="chartType">GAMES</param>
<param name="alignOrder">bestselling</param><param name="status">0</param><param name="gameIncYn">Y</param>
</request></SamsungProtocol>`;
}
async function galaxyGamesPopularRank(guid) {
  try {
    const res = await fetch('https://galaxystore.samsung.com/storeserver/ods.as?id=chartProductList2Notc', {
      method: 'POST',
      headers: { 'content-type': 'application/xml', 'User-Agent': UA_DESKTOP,
        'origin': 'https://galaxystore.samsung.com', 'x-galaxystore-url': 'http://us-odc.samsungapps.com/ods.as' },
      body: galaxyChartPayload(),
    });
    const xml = await res.text();
    const guids = [...xml.matchAll(/<value name="GUID">([^<]+)<\/value>/g)].map(m => m[1]);
    const i = guids.findIndex(g => g === guid || g.startsWith('com.jszx'));
    return i >= 0 ? i + 1 : null;
  } catch (e) { console.warn('  ! 갤럭시 인기순위 실패:', e.message); return null; }
}
// ---- 갤럭시스토어: 공개 JSON API(평점·평가수) + 전체 게임 인기순위(자동) ----
async function collectGalaxy(cid, guid) {
  const res = await fetch(`https://galaxystore.samsung.com/api/detail/${cid}`, { headers: { 'User-Agent': UA_MOBILE } });
  const j = await res.json();
  const dm = j.DetailMain || {};
  const rankFree = guid ? await galaxyGamesPopularRank(guid) : null;
  return {
    overallScore: dm.ratingNumber ? parseFloat(dm.ratingNumber) : null,
    totalRatings: j.commentListTotalCount ? parseInt(j.commentListTotalCount, 10) : null,
    category: dm.generalCategoryName || null, rankFree,
  };
}
// ---- 수동 순위: 구글 시트(CSV) 또는 ranks.json 에서 읽어 병합 ----
function normDate(s) {
  s = (s || '').toString().replace(/\s/g, '');
  const m = s.match(/^(\d{4})[-.\/](\d{1,2})[-.\/](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}
// 순위 셀 파싱: 빈칸=undefined(미입력, 건드리지 않음), 无/없음/-=null(순위없음), 숫자=값
function parseRankCell(v) {
  v = (v || '').toString().trim();
  if (!v) return undefined;
  if (/^(无|無|없음|-|N\/A|na)$/i.test(v)) return null;
  const n = parseInt(v.replace(/[^\d]/g, ''), 10);
  return Number.isNaN(n) ? undefined : n;
}
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}
// 시트에서 가져올 순위: 원스토어 인기+매출, 갤럭시 매출만 (구글/애플/갤럭시인기는 자동)
async function fetchSheetRanks(url) {
  const res = await fetch(url, { redirect: 'follow' });
  const rows = parseCsv(await res.text());
  if (rows.length < 2) return null;
  const findCol = (nameKws, metricKws) => {
    for (let ri = 0; ri < Math.min(rows.length, 6); ri++)
      for (let ci = 0; ci < rows[ri].length; ci++) {
        const h = (rows[ri][ci] || '').replace(/\s/g, '');
        if (nameKws.some(n => h.includes(n)) && metricKws.some(m => h.includes(m))) return ci;
      }
    return -1;
  };
  const POP = ['人气', '인기'], GRS = ['畅销', '매출'];
  const cOnePop = findCol(['OneStore', '원스토어', 'ONE'], POP);
  const cOneGrs = findCol(['OneStore', '원스토어', 'ONE'], GRS);
  const cGalGrs = findCol(['Galaxy', '갤럭시'], GRS);
  const cell = (r, ci) => (ci >= 0 && ci < r.length) ? r[ci] : '';
  const out = { onestore: {}, galaxy: {} };
  for (const r of rows) {
    const date = normDate(r[0]); if (!date) continue;
    const op = parseRankCell(cell(r, cOnePop)), og = parseRankCell(cell(r, cOneGrs));
    if (op !== undefined || og !== undefined) out.onestore[date] = { popular: op, grossing: og };
    const gg = parseRankCell(cell(r, cGalGrs));
    if (gg !== undefined) out.galaxy[date] = { grossing: gg };
  }
  return out;
}
function loadRanksJson() { try { return JSON.parse(readFileSync(join(DIR, 'ranks.json'), 'utf8')); } catch { return null; } }
function applyRanks(db, ranks) {
  if (!ranks) return;
  for (const proj of Object.values(db.projects)) {
    // 원스토어: 인기(rankFree)+매출(rankGrossing) — 시트값이 있으면 덮어씀(无=null=순위없음)
    for (const [date, v] of Object.entries(ranks.onestore || {})) {
      if (!v) continue;
      proj.days[date] ??= { stores: {} };
      const s = (proj.days[date].stores.onestore ??= { metricsOnly: true });
      if (v.popular !== undefined) s.rankFree = v.popular;
      if (v.grossing !== undefined) s.rankGrossing = v.grossing;
    }
    // 갤럭시: 매출만 (인기는 자동수집 유지)
    for (const [date, v] of Object.entries(ranks.galaxy || {})) {
      if (!v || v.grossing === undefined) continue;
      proj.days[date] ??= { stores: {} };
      const s = (proj.days[date].stores.galaxy ??= { metricsOnly: true });
      s.rankGrossing = v.grossing;
    }
  }
}
// 지표 전용 스토어: 오늘자 스냅샷에 평점 등 기록 (리뷰/순위 없음)
function mergeMetrics(days, key, r) {
  days[TODAY] ??= { stores: {} };
  days[TODAY].stores[key] = {
    ...(days[TODAY].stores[key] || {}), metricsOnly: true,
    overallScore: r.overallScore, totalRatings: r.totalRatings ?? null,
    downloads: r.downloads ?? null, rankFree: r.rankFree ?? null, rankGrossing: r.rankGrossing ?? null,
  };
  days[TODAY].collectedAt = new Date().toISOString();
}

// ---- 스토어 결과를 db 에 병합: 리뷰는 날짜별로, 순위/전체별점은 오늘자에만 ----
function mergeStore(projDays, storeKey, result) {
  // 리뷰: 각 날짜 버킷을 해당 일자에 기록 (기존 분류 감성/주제는 id로 매칭해 보존)
  for (const [d, rv] of Object.entries(result.reviewsByDate)) {
    projDays[d] ??= { stores: {} };
    const prevMap = {};
    for (const p of (projDays[d].stores[storeKey]?.reviews || [])) prevMap[p.id] = p;
    for (const r of rv.reviews) {
      const p = prevMap[r.id];
      if (p) { if (p.sentiment != null) r.sentiment = p.sentiment; if (p.topic != null) r.topic = p.topic; }
    }
    projDays[d].stores[storeKey] = { ...(projDays[d].stores[storeKey] || {}), ...rv };
  }
  // 순위/전체별점: 실행 시점(오늘) 스냅샷
  projDays[TODAY] ??= { stores: {} };
  projDays[TODAY].stores[storeKey] = {
    ...(projDays[TODAY].stores[storeKey] || {}),
    overallScore: result.overallScore, totalRatings: result.totalRatings,
    rankFree: result.rankFree, rankGrossing: result.rankGrossing,
  };
  projDays[TODAY].collectedAt = new Date().toISOString();
}

// ---- 메인 ----
const outPath = join(DIR, 'data.json');
const db = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : { projects: {}, meta: {} };

for (const proj of cfg.projects) {
  console.log(`\n▶ ${proj.name} (${TODAY})`);
  db.projects[proj.id] ??= { name: proj.name, days: {} };
  db.projects[proj.id].name = proj.name;
  const days = db.projects[proj.id].days;
  if (proj.google) {
    try {
      const g = await collectGoogle(proj.google, proj.googleCategory);
      mergeStore(days, 'google', g);
      const todayNew = g.reviewsByDate[TODAY]?.newCount || 0;
      console.log('  ✓ 구글: 순위(무료/매출)', g.rankFree ?? '순위없음', '/', g.rankGrossing ?? '순위없음',
        '· 오늘 리뷰', todayNew, '· 리뷰 확보일수', Object.keys(g.reviewsByDate).length);
    } catch (e) { console.warn('  ✗ 구글 수집 실패:', e.message); }
  }
  if (proj.apple) {
    try {
      const a = await collectApple(proj.apple, proj.appleCategory);
      mergeStore(days, 'apple', a);
      const todayNew = a.reviewsByDate[TODAY]?.newCount || 0;
      console.log('  ✓ 애플: 순위(무료/매출)', a.rankFree ?? '순위없음', '/', a.rankGrossing ?? '순위없음',
        '· 오늘 리뷰', todayNew, '· 리뷰 확보일수', Object.keys(a.reviewsByDate).length);
    } catch (e) { console.warn('  ✗ 애플 수집 실패:', e.message); }
  }
  if (proj.onestore) {
    try { const o = await collectOnestore(proj.onestore); mergeMetrics(days, 'onestore', o);
      console.log('  ✓ 원스토어(지표): ★' + o.overallScore + ' · 다운로드 ' + o.downloads); }
    catch (e) { console.warn('  ✗ 원스토어 수집 실패:', e.message); }
  }
  if (proj.galaxy) {
    try { const g = await collectGalaxy(proj.galaxy, proj.galaxyGuid); mergeMetrics(days, 'galaxy', g);
      console.log('  ✓ 갤럭시(지표): ★' + g.overallScore + ' · 누적평가 ' + g.totalRatings + ' · 전체게임 인기순위 ' + (g.rankFree ?? '순위없음')); }
    catch (e) { console.warn('  ✗ 갤럭시 수집 실패:', e.message); }
  }
}

// 수동 순위: 구글 시트(있으면) 우선, 없으면 ranks.json. 자동 수집값이 있으면 자동 우선.
let manualRanks = null;
// 시트 URL은 환경변수(RANKS_SHEET_CSV_URL) 우선, 없으면 config. (공개 리포엔 링크를 두지 않기 위함)
const SHEET_URL = process.env.RANKS_SHEET_CSV_URL || cfg.ranksSheetCsvUrl;
if (SHEET_URL) {
  try { manualRanks = await fetchSheetRanks(SHEET_URL); console.log('  📄 구글시트 순위 로드됨'); }
  catch (e) { console.warn('  ! 구글시트 로드 실패:', e.message); }
}
if (!manualRanks) manualRanks = loadRanksJson();
applyRanks(db, manualRanks);
db.meta.lastRun = new Date().toISOString();
db.meta.country = COUNTRY;
writeFileSync(outPath, JSON.stringify(db, null, 2));
console.log(`\n💾 저장 완료 → data.json  (누적 일자: ${Object.keys(db.projects[cfg.projects[0].id].days).length}일)`);

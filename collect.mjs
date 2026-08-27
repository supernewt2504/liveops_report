// 게임 운영 대시보드 - 구글/애플 데이터 수집기
// 사용법: node collect.mjs   (매일 1회 실행 → data.json 에 당일 스냅샷 누적)
import gplay from 'google-play-scraper';
import store from 'app-store-scraper';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchCsReport, helpdeskEnabled } from './lib/helpdesk.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
// 런타임 데이터(data.json)·빌드 산출물 저장 위치. 클라우드는 영구 볼륨(/data), 로컬은 코드 디렉터리.
const DATA_DIR = process.env.DATA_DIR || DIR;
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
    overallScore: app.score != null ? +app.score.toFixed(2) : null, totalRatings: app.ratings ?? null,
    rankFree: freeRank, rankGrossing: grossRank,
    reviewsByDate: bucketReviews(norm), iconUrl: app.icon ? app.icon.replace(/=[sw]\d+.*$/, '') + '=s96' : null,
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
    overallScore: app.score != null ? +app.score.toFixed(2) : null, totalRatings: app.reviews ?? null,
    rankFree: freeRank, rankGrossing: grossRank,
    reviewsByDate: bucketReviews(norm), iconUrl: app.icon ? app.icon.replace(/\/\d+x\d+bb\.(jpg|png)(\?.*)?$/, '/96x96bb.$1') : null,
  };
}

// ---- 원스토어: 상품 페이지에서 평점·다운로드 파싱 (지표 위주, 리뷰 미수집) ----
const UA_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const UA_MOBILE = 'Mozilla/5.0 (Linux; Android 13; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36';
// 아이콘 이미지를 base64 data URI로 (아티팩트 CSP가 외부 이미지를 막으므로 HTML에 임베드)
async function fetchDataUri(url) {
  if (!url) return null;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA_DESKTOP } });
    if (!r.ok) return null;
    const ct = (r.headers.get('content-type') || 'image/png').split(';')[0];
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 600000) return null; // 과대 이미지는 스킵(경량 유지)
    return `data:${ct};base64,${buf.toString('base64')}`;
  } catch { return null; }
}
async function collectOnestore(pid) {
  const res = await fetch(`https://m.onestore.co.kr/v2/ko-kr/app/${pid}`, { headers: { 'User-Agent': UA_DESKTOP } });
  const html = await res.text();
  const rating = html.match(/meta">([\d.]+)<\/span><span class="[^"]*caption">평점/);
  const dl = html.match(/meta">([^<]+)<\/span><span class="[^"]*caption">다운로드/);
  // 앱 아이콘: 122x122 썸네일 중 자사 PID 포함 URL (없으면 첫 122_122)
  const iconM = html.match(new RegExp(`https://img\\.onestore\\.co\\.kr/thumbnails/img_sac/122_122_[^"' ]*${pid}[^"' ]*`))
    || html.match(/https:\/\/img\.onestore\.co\.kr\/thumbnails\/img_sac\/122_122_[^"' ]+/);
  return { overallScore: rating ? parseFloat(rating[1]) : null, downloads: dl ? dl[1].trim() : null, iconUrl: iconM ? iconM[0] : null };
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
    iconUrl: dm.iconURL ? dm.iconURL.replace(/_512_512(\.png)/i, '_135_135$1') : null,
  };
}
// ---- 네이버 라운지: 공개 커뮤니티 API (인증 불필요) ----
// SPA 번들 역설계로 도출한 내부 API. 베이스 comm-api.game.naver.com/nng_main/v1,
// 슬러그(Heart_of_Valor)가 곧 loungeId. Referer 헤더 필수.
// 방문자수(관리자 통계)만 자동 불가 → 시트 수동입력 예정. 그 외 게시물은 공개라 자동.
const LOUNGE_BASE = 'https://comm-api.game.naver.com/nng_main/v1';
const loungeHeaders = { 'Referer': 'https://game.naver.com/', 'User-Agent': UA_DESKTOP, 'Accept': 'application/json' };
async function loungeGet(path) {
  const res = await fetch(`${LOUNGE_BASE}${path}`, { headers: loungeHeaders });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  const j = await res.json();
  if (j.code && j.code !== 200) throw new Error(`${path} → code ${j.code} ${j.message || ''}`);
  return j.content;
}
// SE 문서(JSON)에서 순수 텍스트만 재귀 추출 (본문 요약/표시용)
function seText(contents) {
  if (!contents) return '';
  let doc; try { doc = JSON.parse(contents); } catch { return ''; }
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n['@ctype'] === 'textNode' && typeof n.value === 'string') out.push(n.value);
    for (const k of ['value', 'nodes', 'components']) if (n[k]) walk(n[k]);
  };
  walk(doc.document?.components || doc.components || []);
  return out.join(' ').replace(/\s+/g, ' ').trim();
}
// 상세글 본문은 SmartEditor HTML → 순수 텍스트 (이벤트 기간·내용 추출용)
function decodeEntities(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ''; } });
}
function stripHtml(h) {
  if (!h) return '';
  return decodeEntities(h.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
// 피드 정규화: 대시보드/요약에 필요한 필드만 추림
function normFeed(it) {
  const f = it.feed || {};
  const text = seText(f.contents).slice(0, 600);
  return {
    feedId: f.feedId,
    title: (f.title || '').trim(),
    board: f.board?.boardName || it.board?.boardName || null,
    boardId: f.board?.boardId ?? it.board?.boardId ?? null,
    createdDate: f.createdDate || null,        // YYYYMMDDHHmmss
    createdKst: f.createdDate ? `${f.createdDate.slice(0,4)}-${f.createdDate.slice(4,6)}-${f.createdDate.slice(6,8)}` : null,
    commentCount: it.comment?.totalCount ?? 0,
    buffCount: it.buff?.buffCount ?? f.buff ?? 0,
    nerfCount: it.buff?.nerfCount ?? f.nerf ?? 0,
    readCount: it.readCount ?? 0,
    author: it.user?.nickname || null,
    url: it.feedLink?.pc || `https://game.naver.com/lounge/${f.loungeId}/board/detail/${f.feedId}`,
    text,
  };
}
// 게시판별 피드(new/popularFeeds/board) 는 필드가 플랫하게 옴 (feed 중첩 없음)
function normFlatFeed(f, boardName) {
  return {
    feedId: f.feedId,
    title: (f.title || '').trim(),
    board: boardName || null,
    createdDate: f.createdDate || null,
    createdKst: f.createdDate ? `${f.createdDate.slice(0,4)}-${f.createdDate.slice(4,6)}-${f.createdDate.slice(6,8)}` : null,
    commentCount: f.commentCount ?? 0,
    buffCount: f.buffCount ?? 0,
    nerfCount: f.nerfCount ?? 0,
    readCount: f.readCount ?? 0,
    author: f.user?.nickname || null,
    url: f.feedPcLink || `https://game.naver.com/lounge/${f.loungeId || ''}/board/detail/${f.feedId}`,
    text: seText(f.contents).slice(0, 500),
  };
}
async function collectLounge(slug) {
  // 1) 게시판 구조 (그룹 정보 포함)
  let boards = [];
  try {
    const b = await loungeGet(`/lounge/${slug}/board`);
    let curGroup = null;
    for (const v of (b.boardViews || [])) {
      if (v.viewType === 'BOARD_GROUP') curGroup = v.groupName || null;
      else if (v.board) boards.push({ boardId: v.board.boardId, name: v.board.boardName, group: curGroup, lastDateTime: v.board.lastDateTime || null });
    }
  } catch (e) { console.warn('  ! 라운지 게시판 조회 실패:', e.message); }
  // 2) 최근 커뮤니티 글 (최대 30) + 누적 게시물 수 (KPI·추이·오늘신규용)
  const rc = await loungeGet(`/lounge/${slug}/recentCommunity/feeds?limit=30`);
  const recent = (rc.feeds || []).map(normFeed);
  const totalPosts = rc.totalCount ?? null;
  const newToday = recent.filter(f => f.createdKst === TODAY).length;
  // 3) 게시판별 최근글/인기글 (new/popularFeeds/board?boardId=) — 원래 기획: 메뉴별 글
  const boardFeeds = {};
  for (const bd of boards) {
    try {
      const c = await loungeGet(`/lounge/${slug}/new/popularFeeds/board?boardId=${bd.boardId}&limit=15`);
      const recentF = (c.recentFeeds || []).map(f => normFlatFeed(f, bd.name));
      const popularF = (c.popularFeeds || []).map(f => normFlatFeed(f, bd.name));
      if (recentF.length || popularF.length)
        boardFeeds[bd.boardId] = { boardId: bd.boardId, name: bd.name, group: bd.group, recent: recentF, popular: popularF };
    } catch (e) { /* 비활성 게시판은 조용히 스킵 */ }
  }
  // 4) 이벤트 게시판(6) 상세 → 기간/내용 추출용 텍스트 (진행중 이벤트 정리용)
  const events = [];
  const EVENT_BOARD_IDS = [6];
  for (const bid of EVENT_BOARD_IDS) {
    const bf = boardFeeds[bid]; if (!bf) continue;
    for (const f of (bf.recent || []).slice(0, 8)) {
      try {
        const c = await loungeGet(`/community/lounge/${slug}/feed/${f.feedId}`);
        const detailText = stripHtml(c.feed?.contents || '').slice(0, 1200);
        events.push({ feedId: f.feedId, title: f.title, url: f.url, createdKst: f.createdKst, detailText });
      } catch (e) { /* 상세 실패 스킵 */ }
    }
  }
  return { slug, totalPosts, newToday, boards, recent, boardFeeds, events };
}
function mergeLounge(days, snap) {
  days[TODAY] ??= { stores: {} };
  days[TODAY].lounge = { ...snap, collectedAt: new Date().toISOString() };
  days[TODAY].collectedAt = new Date().toISOString();
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
  const cGalPop = findCol(['Galaxy', '갤럭시'], POP);   // 갤럭시 인기(자동수집 실패 시 보완)
  const cGalGrs = findCol(['Galaxy', '갤럭시'], GRS);
  const cell = (r, ci) => (ci >= 0 && ci < r.length) ? r[ci] : '';
  const out = { onestore: {}, galaxy: {} };
  for (const r of rows) {
    const date = normDate(r[0]); if (!date) continue;
    const op = parseRankCell(cell(r, cOnePop)), og = parseRankCell(cell(r, cOneGrs));
    if (op !== undefined || og !== undefined) out.onestore[date] = { popular: op, grossing: og };
    const gp = parseRankCell(cell(r, cGalPop)), gg = parseRankCell(cell(r, cGalGrs));
    if (gp !== undefined || gg !== undefined) out.galaxy[date] = { popular: gp, grossing: gg };
  }
  return out;
}
function loadRanksJson() { try { return JSON.parse(readFileSync(join(DIR, 'ranks.json'), 'utf8')); } catch { return null; } }
// ranks(시트/ranks.json)는 프로젝트별 소스 → 지정 프로젝트에만 적용(다른 게임에 번지지 않게).
function applyRanks(db, ranks, targetId) {
  if (!ranks) return;
  const proj = db.projects[targetId];
  if (!proj) return;
  // 원스토어: 인기(rankFree)+매출(rankGrossing) — 시트값이 있으면 덮어씀(无=null=순위없음)
  for (const [date, v] of Object.entries(ranks.onestore || {})) {
    if (!v) continue;
    proj.days[date] ??= { stores: {} };
    const s = (proj.days[date].stores.onestore ??= { metricsOnly: true });
    if (v.popular !== undefined) s.rankFree = v.popular;
    if (v.grossing !== undefined) s.rankGrossing = v.grossing;
  }
  // 갤럭시: 매출은 시트, 인기는 자동수집 우선(있으면 유지)·실패 시(클라우드 등) 시트값으로 보완
  for (const [date, v] of Object.entries(ranks.galaxy || {})) {
    if (!v) continue;
    proj.days[date] ??= { stores: {} };
    const s = (proj.days[date].stores.galaxy ??= { metricsOnly: true });
    if (v.grossing !== undefined) s.rankGrossing = v.grossing;
    if (v.popular !== undefined && s.rankFree == null) s.rankFree = v.popular;
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
const outPath = join(DATA_DIR, 'data.json');
const db = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : { projects: {}, meta: {} };

const PROJ_FILTER = process.env.PROJECT; // 특정 프로젝트만 수집(다른 프로젝트 데이터 보존)
for (const proj of cfg.projects) {
  if (PROJ_FILTER && proj.id !== PROJ_FILTER) continue;
  console.log(`\n▶ ${proj.name} (${TODAY})`);
  db.projects[proj.id] ??= { name: proj.name, days: {} };
  db.projects[proj.id].name = proj.name;
  const days = db.projects[proj.id].days;
  const iconUrls = {};
  if (proj.google) {
    try {
      const g = await collectGoogle(proj.google, proj.googleCategory);
      mergeStore(days, 'google', g); iconUrls.google = g.iconUrl;
      const todayNew = g.reviewsByDate[TODAY]?.newCount || 0;
      console.log('  ✓ 구글: 순위(무료/매출)', g.rankFree ?? '순위없음', '/', g.rankGrossing ?? '순위없음',
        '· 오늘 리뷰', todayNew, '· 리뷰 확보일수', Object.keys(g.reviewsByDate).length);
    } catch (e) { console.warn('  ✗ 구글 수집 실패:', e.message); }
  }
  if (proj.apple) {
    try {
      const a = await collectApple(proj.apple, proj.appleCategory);
      mergeStore(days, 'apple', a); iconUrls.apple = a.iconUrl;
      const todayNew = a.reviewsByDate[TODAY]?.newCount || 0;
      console.log('  ✓ 애플: 순위(무료/매출)', a.rankFree ?? '순위없음', '/', a.rankGrossing ?? '순위없음',
        '· 오늘 리뷰', todayNew, '· 리뷰 확보일수', Object.keys(a.reviewsByDate).length);
    } catch (e) { console.warn('  ✗ 애플 수집 실패:', e.message); }
  }
  if (proj.onestore) {
    try { const o = await collectOnestore(proj.onestore); mergeMetrics(days, 'onestore', o); iconUrls.onestore = o.iconUrl;
      console.log('  ✓ 원스토어(지표): ★' + o.overallScore + ' · 다운로드 ' + o.downloads); }
    catch (e) { console.warn('  ✗ 원스토어 수집 실패:', e.message); }
  }
  if (proj.galaxy) {
    try { const g = await collectGalaxy(proj.galaxy, proj.galaxyGuid); mergeMetrics(days, 'galaxy', g); iconUrls.galaxy = g.iconUrl;
      console.log('  ✓ 갤럭시(지표): ★' + g.overallScore + ' · 누적평가 ' + g.totalRatings + ' · 전체게임 인기순위 ' + (g.rankFree ?? '순위없음')); }
    catch (e) { console.warn('  ✗ 갤럭시 수집 실패:', e.message); }
  }
  // 스토어 아이콘(각 스토어에 노출 중인 아이콘)을 data URI로 임베드 — 아티팩트 CSP 대응
  const icons = (db.projects[proj.id].icons ??= {});
  for (const key of ['google', 'apple', 'onestore', 'galaxy']) {
    if (!iconUrls[key]) continue;
    const uri = await fetchDataUri(iconUrls[key]);
    if (uri) { icons[key] = uri; } // 실패 시 기존 아이콘 유지
  }
  // 갤럭시 아이콘: 자동수집(삼성 CDN) 실패 시 리포지토리 고정 파일로 대체 — 클라우드에서 정확한 갤럭시 아이콘 표시
  if (proj.galaxyIconFile && !iconUrls.galaxy) {
    try {
      const buf = readFileSync(join(DIR, proj.galaxyIconFile));
      const ext = /\.jpe?g$/i.test(proj.galaxyIconFile) ? 'jpeg' : 'png';
      icons.galaxy = `data:image/${ext};base64,${buf.toString('base64')}`;
      console.log('  ↩ 갤럭시 아이콘 파일 대체:', proj.galaxyIconFile);
    } catch (e) { console.warn('  ! 갤럭시 아이콘 파일 로드 실패:', e.message); }
  }
  console.log('  ✓ 스토어 아이콘 임베드:', Object.keys(icons).join(', ') || '없음');
  if (proj.lounge) {
    try { const l = await collectLounge(proj.lounge); mergeLounge(days, l);
      console.log('  ✓ 네이버 라운지: 누적 게시물 ' + l.totalPosts + ' · 오늘 신규 ' + l.newToday + ' · 게시판 ' + l.boards.length + ' · 글 있는 게시판 ' + Object.keys(l.boardFeeds).length + ' · 이벤트글 ' + (l.events?.length || 0)); }
    catch (e) { console.warn('  ✗ 라운지 수집 실패:', e.message); }
  }
  // 고객센터(helpdesk) 문의 집계 — projectA 등 helpdesk=true 프로젝트만. 최근 30일 창.
  if (proj.helpdesk && proj.helpdeskGame && helpdeskEnabled()) {
    try {
      const to = TODAY;
      const fromD = new Date(new Date(TODAY + 'T00:00:00Z').getTime() - 30 * 864e5).toISOString().slice(0, 10);
      const cs = await fetchCsReport(proj.helpdeskGame, fromD, to);
      db.projects[proj.id].cs = { ...cs, fetchedAt: new Date().toISOString() };
      const totCreated = (cs.daily || []).reduce((s, d) => s + (d.created || 0), 0);
      const totResolved = (cs.daily || []).reduce((s, d) => s + (d.resolved || 0), 0);
      console.log('  ✓ 고객센터: 최근30일 문의 ' + totCreated + '건 · 처리 ' + totResolved + '건 · 목록 ' + (cs.inquiries || []).length + '건');
    } catch (e) { console.warn('  ✗ 고객센터 수집 실패:', e.message); }
  } else if (proj.helpdesk && !helpdeskEnabled()) {
    console.log('  ℹ 고객센터 스킵 (HELPDESK_API_URL/HELPDESK_API_TOKEN 미설정)');
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
// 순위 시트/ranks.json 은 첫 프로젝트(부족또전쟁) 전용. 다른 프로젝트만 수집할 땐 건드리지 않음.
const RANK_TARGET = cfg.projects[0].id;
if (!PROJ_FILTER || PROJ_FILTER === RANK_TARGET) applyRanks(db, manualRanks, RANK_TARGET);

// 갤럭시 별점 폴백: 자동수집(삼성API)이 클라우드에서 막혀 별점이 null이므로, 설정값으로 고정.
// 시트/수집으로 galaxy 스냅샷이 있는 '모든 날짜'에 채워, 리포트가 전일을 표시해도 별점이 보이게 함.
for (const proj of cfg.projects) {
  if (proj.galaxyRatingFallback == null) continue;
  const pdays = db.projects[proj.id]?.days || {};
  for (const d of Object.keys(pdays)) {
    const g = pdays[d].stores?.galaxy;
    if (g && g.overallScore == null) {
      g.overallScore = proj.galaxyRatingFallback;
      if (g.totalRatings == null && proj.galaxyTotalRatingsFallback != null) g.totalRatings = proj.galaxyTotalRatingsFallback;
    }
  }
}

db.meta.lastRun = new Date().toISOString();
db.meta.country = COUNTRY;
writeFileSync(outPath, JSON.stringify(db, null, 2));
console.log(`\n💾 저장 완료 → data.json  (누적 일자: ${Object.keys(db.projects[cfg.projects[0].id].days).length}일)`);

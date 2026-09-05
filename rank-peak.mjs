// 일중 순위 피크 수집 — 구글/애플 무료·매출 순위를 조회해 '오늘' 스냅샷의
// 최고 순위(가장 작은 숫자)로 갱신한다. 하루 여러 번 실행(스케줄러)해 장중 피크를 포착.
// 전체 파이프라인(리뷰·요약·시트·메일)과 별개이며, 메일 발송/LLM 호출 없음.
//   PROJECT : 특정 프로젝트만(옵션). DATA_DIR : 데이터 위치(클라우드=/data).
import gplay from 'google-play-scraper';
import store from 'app-store-scraper';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || DIR;
const cfg = JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf8'));
const COUNTRY = cfg.country || 'kr';
const PROJ_FILTER = process.env.PROJECT;
const kstDate = (d = new Date()) => new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const TODAY = kstDate();

async function googleRank(appId, collection, category) {
  try { const l = await gplay.list({ collection, category, country: COUNTRY, num: 200 }); const i = l.findIndex(a => a.appId === appId); return i >= 0 ? i + 1 : null; }
  catch (e) { console.warn('  ! google rank 실패:', e.message); return null; }
}
async function appleRank(appId, collection, category) {
  try { const l = await store.list({ collection, category, country: COUNTRY, num: 200 }); const i = l.findIndex(a => String(a.id) === String(appId)); return i >= 0 ? i + 1 : null; }
  catch (e) { console.warn('  ! apple rank 실패:', e.message); return null; }
}
// 더 좋은 순위(작은 숫자)를 채택. null(차트 밖)은 기존값 유지 → 그날의 최고 순위 보존.
const better = (a, b) => (a == null ? b : b == null ? a : Math.min(a, b));

const dbPath = join(DATA_DIR, 'data.json');
const db = JSON.parse(readFileSync(dbPath, 'utf8'));
let changed = false;

for (const proj of (cfg.projects || [])) {
  if (PROJ_FILTER && proj.id !== PROJ_FILTER) continue;
  const p = db.projects?.[proj.id];
  if (!p) continue;
  p.days ??= {};
  p.days[TODAY] ??= { stores: {} };
  p.days[TODAY].stores ??= {};
  const excl = new Set(proj.excludeStores || []);
  const gcat = gplay.category[proj.googleCategory] || gplay.category.GAME;
  const acat = store.category[proj.appleCategory] || store.category.GAMES;

  if (proj.google && !excl.has('google')) {
    const [f, g] = await Promise.all([
      googleRank(proj.google, gplay.collection.TOP_FREE, gcat),
      googleRank(proj.google, gplay.collection.GROSSING, gcat),
    ]);
    const s = (p.days[TODAY].stores.google ??= { metricsOnly: true });
    const nf = better(s.rankFree, f), ng = better(s.rankGrossing, g);
    if (nf !== s.rankFree || ng !== s.rankGrossing) { s.rankFree = nf; s.rankGrossing = ng; changed = true; }
  }
  if (proj.apple && !excl.has('apple')) {
    const [f, g] = await Promise.all([
      appleRank(proj.apple, store.collection.TOP_FREE_IOS, acat),
      appleRank(proj.apple, store.collection.TOP_GROSSING_IOS, acat),
    ]);
    const s = (p.days[TODAY].stores.apple ??= { metricsOnly: true });
    const nf = better(s.rankFree, f), ng = better(s.rankGrossing, g);
    if (nf !== s.rankFree || ng !== s.rankGrossing) { s.rankFree = nf; s.rankGrossing = ng; changed = true; }
  }
  const G = p.days[TODAY].stores.google || {}, A = p.days[TODAY].stores.apple || {};
  console.log(`  ✓ [${proj.id}] 피크 — 구글 인기 ${G.rankFree ?? '-'}/매출 ${G.rankGrossing ?? '-'} · 애플 인기 ${A.rankFree ?? '-'}/매출 ${A.rankGrossing ?? '-'}`);
}

if (changed) {
  db.meta ??= {};
  db.meta.peakUpdatedAt = new Date().toISOString();
  writeFileSync(dbPath, JSON.stringify(db, null, 2));
  console.log(`💾 순위 피크 반영(${TODAY}) → data.json`);
} else {
  console.log('ℹ 순위 변화 없음(갱신 생략)');
}

// 라운지 주간 동향 통계 (읽기 전용, 출력만) — 주간보고서 작성 보조
// 사용: node lounge-weekly.mjs [YYYY-MM-DD]  (기준일 미지정 시 최신일)
// 최근 7일(기준일 포함)의 lounge 스냅샷에서 누적 게시물 증가·일평균 신규글·방문자수 추세·최신 여론요약을 계산해 출력.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const db = JSON.parse(readFileSync(join(DIR, 'data.json'), 'utf8'));
const proj = db.projects[Object.keys(db.projects)[0]];
const allDates = Object.keys(proj.days).sort();
const end = process.argv[2] || allDates[allDates.length - 1];
// 기준일로부터 과거 7일 창
const endD = new Date(end + 'T00:00:00Z');
const start = new Date(endD.getTime() - 6 * 86400000).toISOString().slice(0, 10);
const win = allDates.filter(d => d >= start && d <= end);
const deEnt = (s) => (s || '').replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } }).replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(+d); } catch { return ''; } }).replace(/&amp;/g, '&');

const snaps = win.map(d => ({ date: d, ...(proj.days[d].lounge || {}) })).filter(s => s.totalPosts != null || s.visitors != null || (s.recent || []).length);

console.log(`\n📊 네이버 라운지 주간 동향 (${start} ~ ${end})`);
if (!snaps.length) { console.log('  · 해당 기간 라운지 스냅샷 없음'); process.exit(0); }

const withPosts = snaps.filter(s => s.totalPosts != null);
if (withPosts.length) {
  const first = withPosts[0], lastS = withPosts[withPosts.length - 1];
  const delta = (lastS.totalPosts != null && first.totalPosts != null) ? lastS.totalPosts - first.totalPosts : null;
  const news = snaps.map(s => s.newToday).filter(n => n != null);
  const avgNew = news.length ? (news.reduce((a, b) => a + b, 0) / news.length).toFixed(1) : '-';
  console.log(`  · 누적 게시물: ${first.totalPosts?.toLocaleString('ko-KR')} → ${lastS.totalPosts?.toLocaleString('ko-KR')}` +
    (delta != null ? ` (${delta >= 0 ? '+' : ''}${delta.toLocaleString('ko-KR')}건)` : '') + ` · 관측 ${withPosts.length}일`);
  console.log(`  · 일평균 신규글: ${avgNew}건`);
}
// 최신 여론요약 + 진행 공지(공지·이벤트 게시판 최근 제목)
const latest = [...snaps].reverse().find(s => s.summary || s.boardFeeds);
if (latest?.summary?.gist?.ko) console.log(`  · 여론 요약: ${latest.summary.gist.ko}`);
const bf = latest?.boardFeeds || {};
const noticeTitles = [];
for (const b of Object.values(bf)) {
  if (['공지', '이벤트', '점검&업데이트'].includes(b.name))
    for (const f of (b.recent || []).slice(0, 2)) noticeTitles.push(`${b.name}: ${deEnt(f.title)}`);
}
if (noticeTitles.length) console.log(`  · 진행 공지/이벤트: ${noticeTitles.slice(0, 5).join(' / ')}`);
console.log('');

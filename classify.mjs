// 리뷰 감성·주제 자동 분류 (자동화용) — Anthropic API 사용
// 준비: npm i @anthropic-ai/sdk  &&  export ANTHROPIC_API_KEY=...
// 사용: node classify.mjs   → data.json 의 미분류(topic=null) 리뷰만 분류해 채움
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || DIR;   // 볼륨(/data)의 data.json 사용
const dbPath = join(DATA_DIR, 'data.json');
const db = JSON.parse(readFileSync(dbPath, 'utf8'));

const TOPICS = ['칭찬', '콘텐츠', '계정/로그인', '과금', '뽑기/확률', '버그/접속', '편의성', '보상/리워드', '기타'];
const SENTI = ['긍정', '중립', '부정'];

// 미분류 리뷰 수집 (참조 보관)
const pending = [];
for (const proj of Object.values(db.projects))
  for (const day of Object.values(proj.days))
    for (const s of Object.values(day.stores))
      for (const r of (s.reviews || []))
        if (r.topic == null && (r.text || '').trim()) pending.push(r);

// 라운지 최신 스냅샷 중 요약 미생성분 찾기 (있으면 요약도 갱신)
function latestLoungeNeedingSummary() {
  for (const proj of Object.values(db.projects)) {
    const dates = Object.keys(proj.days).sort();
    for (let i = dates.length - 1; i >= 0; i--) {
      const lo = proj.days[dates[i]].lounge;
      if (lo && (lo.recent || []).length) return lo.summary ? null : lo; // 이미 요약 있으면 스킵
    }
  }
  return null;
}
const loungeToSummarize = latestLoungeNeedingSummary();

if (!pending.length && !loungeToSummarize) { console.log('분류/요약할 신규 항목 없음.'); process.exit(0); }
if (pending.length) console.log('미분류 리뷰:', pending.length, '건');
if (loungeToSummarize) console.log('라운지 요약 대상:', (loungeToSummarize.recent || []).length, '글');

if (!process.env.ANTHROPIC_API_KEY) {
  console.log('⚠ ANTHROPIC_API_KEY 없음 → 분류/요약 건너뜀 (리뷰는 별점 기반, 라운지는 게시판 분포로 표시). 로컬 Claude 세션이 직접 채우거나, 키 설정 후 재실행.');
  process.exit(0);
}
const { default: Anthropic } = await import('@anthropic-ai/sdk'); // 키 있을 때만 로드
const client = new Anthropic(); // ANTHROPIC_API_KEY 환경변수 사용
const MODEL = 'claude-haiku-4-5-20251001'; // 분류는 빠르고 저렴한 모델로 충분
const BATCH = 40;

for (let b = 0; b < pending.length; b += BATCH) {
  const chunk = pending.slice(b, b + BATCH);
  const list = chunk.map((r, i) => `${i}) [${r.score}★] ${(r.text || '').replace(/\s+/g, ' ').slice(0, 200)}`).join('\n');
  const prompt =
`너는 모바일 게임 리뷰 분류기다. 아래 리뷰 각각에 대해 감성과 주제를 정해라.
- 감성(sentiment): ${SENTI.join(', ')} 중 하나. 별점이 높아도 내용이 불만이면 부정으로 판단.
- 주제(topic): ${TOPICS.join(', ')} 중 정확히 하나. 일반적인 재미/추천은 "칭찬".
반드시 JSON 배열로만 답하라. 형식: [{"i":0,"sentiment":"긍정","topic":"칭찬"}, ...]

리뷰:
${list}`;

  const msg = await client.messages.create({
    model: MODEL, max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });
  const txt = msg.content.map(c => c.text || '').join('');
  const json = txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1);
  let arr;
  try { arr = JSON.parse(json); } catch (e) { console.error('파싱 실패, 배치 건너뜀:', e.message); continue; }
  for (const item of arr) {
    const r = chunk[item.i];
    if (!r) continue;
    r.sentiment = SENTI.includes(item.sentiment) ? item.sentiment : '중립';
    r.topic = TOPICS.includes(item.topic) ? item.topic : '기타';
  }
  console.log(`  배치 ${b / BATCH + 1}: ${arr.length}건 분류`);
}

// ---- 라운지 요약: 전체 여론 + 게시판별 요약 (있을 때만) ----
if (loungeToSummarize) {
  const lo = loungeToSummarize;
  // 게시판별 digest (제목·지표 위주 — 게시판별 요약의 근거)
  const bf = lo.boardFeeds || {};
  const boardBlocks = Object.values(bf).map(b => {
    const items = (b.recent || []).slice(0, 8).map(f =>
      `  · ${f.title} (👁${f.readCount} 💬${f.commentCount} 👍${f.buffCount})${f.text ? ' — ' + f.text.replace(/\s+/g, ' ').slice(0, 80) : ''}`).join('\n');
    return `[boardId ${b.boardId}] ${b.name} (${b.group || '-'})\n${items}`;
  }).join('\n');
  const ids = Object.keys(bf).join(', ');
  // 이벤트 게시판 상세(기간/내용 추출용)
  const evBlocks = (lo.events || []).map(e =>
    `feedId ${e.feedId} (작성 ${e.createdKst}): ${e.title}\n  ${(e.detailText || '').slice(0, 400)}`).join('\n');
  const TODAY = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const prompt =
`너는 모바일 게임 커뮤니티 애널리스트다. 아래는 네이버 게임 라운지(공식 커뮤니티)의 게시판별 최근 게시글과 이벤트 상세다.
조회수·댓글·공감이 높을수록 관심이 크다. 오늘 날짜는 ${TODAY}(KST). 아래 4가지를 만들어라(모든 텍스트는 한국어 ko + 중국어 간체 zh 병기):
- gist: 라운지 전체 분위기·핵심 이슈 2~3문장 (진행 이벤트·장애/불만·주목 건의 포함).
- topics: 3~5개 주제. 각 name(짧은 라벨)·note(한 줄)·tone("pos"|"neu"|"neg").
- boards: 게시판별 1~2문장 요약. 키는 boardId(문자열), 값 {ko,zh}. 대상 boardId: ${ids}.
- events: 아래 이벤트 상세에서 '이벤트/쿠폰 사용 기간'을 읽어 각 이벤트를 정리. 각 항목 {feedId(숫자), start("YYYY-MM-DD" 이벤트/쿠폰사용 시작일), end("YYYY-MM-DD" 종료일), period{ko,zh}(표시용 예 "8/21~8/27"), title{ko,zh}(짧게), content{ko,zh}(한 줄)}. 연도 표기가 없으면 게시일(작성일) 연도 사용. 시작일이 불명확하면 게시일을 시작일로. 종료일이 불명확하면 시작일과 동일. (특정 일자에 진행중이었는지 판단에 쓰이므로 start/end 정확도가 중요.) 단순 결과/당첨자 안내 등 기간이 없는 글은 제외.
반드시 아래 JSON만 출력(설명 금지):
{"gist":{"ko":"","zh":""},"topics":[{"name":{"ko":"","zh":""},"note":{"ko":"","zh":""},"tone":"neg"}],"boards":{"3":{"ko":"","zh":""}},"events":[{"feedId":0,"start":"2026-08-21","end":"2026-08-27","period":{"ko":"","zh":""},"title":{"ko":"","zh":""},"content":{"ko":"","zh":""}}]}

게시판별 게시글:
${boardBlocks}

이벤트 상세:
${evBlocks}`;
  try {
    const msg = await client.messages.create({ model: MODEL, max_tokens: 4096, messages: [{ role: 'user', content: prompt }] });
    const txt = msg.content.map(c => c.text || '').join('');
    const obj = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
    // 이벤트 url은 수집 데이터에서 매핑(모델이 링크를 지어내지 않도록)
    const evUrl = {}; for (const e of (lo.events || [])) evUrl[e.feedId] = e.url;
    for (const ev of (obj.events || [])) ev.url = evUrl[ev.feedId] || `https://game.naver.com/lounge/${lo.slug}/board/detail/${ev.feedId}`;
    lo.summary = { ...obj, generatedAt: new Date().toISOString(), model: MODEL, basedOn: Object.keys(bf).length };
    console.log(`  ✓ 라운지 요약 생성 완료 (게시판 ${Object.keys(obj.boards || {}).length} · 이벤트 ${(obj.events || []).filter(e => e.ongoing).length}건 진행중)`);
  } catch (e) { console.error('  ! 라운지 요약 실패:', e.message); }
}

writeFileSync(dbPath, JSON.stringify(db, null, 2));
console.log('완료 → data.json 갱신');

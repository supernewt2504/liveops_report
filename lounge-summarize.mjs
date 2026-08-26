// 네이버 라운지 AI 요약 — 게시판 글·이벤트 본문을 Claude로 요약/번역/기간정리해 lounge.summary 생성.
// 각 프로젝트의 최신 라운지 스냅샷에 summary(gist·topics·events)를 채운다.
//   ANTHROPIC_API_KEY : 필수. 없으면 스킵(요약 없이 진행).
//   LOUNGE_MODEL      : 모델 override (기본 claude-opus-5).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || DIR;
const MODEL = process.env.LOUNGE_MODEL || 'claude-opus-5';
const KEY = process.env.ANTHROPIC_API_KEY;
const PROJ_FILTER = process.env.PROJECT;

if (!KEY) { console.log('ℹ 라운지 요약 스킵 (ANTHROPIC_API_KEY 미설정)'); process.exit(0); }

const dbPath = join(DATA_DIR, 'data.json');
const db = JSON.parse(readFileSync(dbPath, 'utf8'));
const cfg = JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf8'));

const SYSTEM = `당신은 게임 운영 애널리스트입니다. 네이버 라운지(커뮤니티) 데이터를 분석해 운영진용 요약을 만듭니다.
반드시 아래 JSON 스키마에 정확히 맞는 JSON만 출력하세요. 설명·마크다운·코드펜스 없이 JSON 객체 하나만.

{
  "gist": { "ko": "2~3문장 여론 요약(활발한 주제·불만·건의 중심)", "zh": "위 내용의 중국어 번역" },
  "topics": [ { "name": {"ko":"주제명","zh":"中文"}, "note": {"ko":"한줄 설명","zh":"中文"}, "tone": "pos|neg|neu" } ],
  "events": [ { "feedId": <입력 이벤트의 feedId 숫자>, "start": "YYYY-MM-DD 또는 null", "end": "YYYY-MM-DD 또는 null", "period": {"ko":"쿠폰 사용 ~8/29(토) 같은 짧은 기간표기","zh":"中文"}, "title": {"ko":"이벤트 짧은 제목","zh":"中文"}, "content": {"ko":"1~2문장 핵심 요약","zh":"中文"}, "url": "<입력 이벤트의 url>" } ]
}

규칙:
- topics는 3~5개. 가장 활발하거나 운영상 중요한 주제 위주. tone은 긍정(pos)/부정(neg)/중립(neu).
- events는 입력으로 준 이벤트만 대상. 본문에서 이벤트 기간(시작·종료일)을 찾아 start/end(YYYY-MM-DD)와 period 표기를 만들고, 제목·내용을 한/중 간결히. 기간을 못 찾으면 start/end는 null.
- 모든 텍스트는 운영 보고 톤. 과장 없이 사실 위주.`;

function buildInput(lo) {
  const boardLines = [];
  let postCount = 0;
  for (const bid of Object.keys(lo.boardFeeds || {})) {
    const bf = lo.boardFeeds[bid];
    const posts = (bf.recent || []).slice(0, 8);
    postCount += posts.length;
    const lines = posts.map(f => `- ${f.title} (댓글 ${f.commentCount || 0}·조회 ${f.readCount || 0}·${f.createdKst})`);
    if (lines.length) boardLines.push(`[${bf.group} · ${bf.name}]\n${lines.join('\n')}`);
  }
  const events = (lo.events || []).map(e => ({ feedId: e.feedId, url: e.url, createdKst: e.createdKst,
    block: `feedId: ${e.feedId}\nurl: ${e.url}\ncreatedKst: ${e.createdKst}\n제목: ${e.title}\n본문: ${e.detailText}` }));
  return { boardText: boardLines.join('\n\n'), events, postCount };
}

async function summarizeProject(projId) {
  const proj = db.projects[projId];
  if (!proj) return;
  const days = proj.days;
  const dates = Object.keys(days).sort();
  const latest = [...dates].reverse().find(d => days[d].lounge?.boardFeeds);
  if (!latest) { console.log(`  [${projId}] 라운지 데이터 없음 → 스킵`); return; }
  const lo = days[latest].lounge;
  const { boardText, events, postCount } = buildInput(lo);
  if (!postCount && !events.length) { console.log(`  [${projId}] 요약할 글 없음 → 스킵`); return; }

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: KEY });
  const userMsg = `게임: ${proj.name}\n기준일: ${latest}\n누적 게시물: ${lo.totalPosts} · 오늘 신규: ${lo.newToday}\n\n=== 게시판 최근 글 ===\n${boardText}\n\n=== 이벤트/공지 (본문 포함, 이 목록만 events로 정리) ===\n${events.map(e => e.block).join('\n\n---\n\n')}`;

  const resp = await client.messages.create({
    model: MODEL, max_tokens: 8000,
    thinking: { type: 'adaptive' }, output_config: { effort: 'medium' },
    system: SYSTEM,
    messages: [{ role: 'user', content: userMsg }],
  });
  const txt = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const jsonStr = txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1);
  let out;
  try { out = JSON.parse(jsonStr); }
  catch (e) { console.error(`  ✗ [${projId}] 요약 JSON 파싱 실패: ${e.message}`); return; }

  // 입력 이벤트의 url 보정(모델이 누락/변형 시 feedId로 원본 url 매핑)
  const byId = Object.fromEntries(events.map(e => [String(e.feedId), e.url]));
  for (const ev of (out.events || [])) if (byId[String(ev.feedId)]) ev.url = byId[String(ev.feedId)];

  days[latest].lounge.summary = {
    gist: out.gist, topics: out.topics || [], boards: lo.boards?.length || 0, events: out.events || [],
    generatedAt: new Date().toISOString(), model: MODEL, basedOn: postCount + events.length,
  };
  console.log(`  ✓ [${projId}] 라운지 요약 생성 (${latest}, 분석 ${postCount + events.length}건, 이벤트 ${(out.events || []).length}개)`);
}

for (const p of (cfg.projects || [])) {
  if (PROJ_FILTER && p.id !== PROJ_FILTER) continue;
  try { await summarizeProject(p.id); }
  catch (e) { console.error(`  ✗ [${p.id}] 요약 실패: ${e.message}`); }
}
writeFileSync(dbPath, JSON.stringify(db, null, 2));
console.log('✅ 라운지 요약 완료 → data.json 갱신');

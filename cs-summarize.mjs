// 고객센터 AI 요약 — 리포트 기준 기간(일간=직전 완료일, 주간=최신 주)의 문의만 요약.
// helpdesk=true 프로젝트의 db.projects[id].cs.summary = { day:{...}, weeks:{ "<mon>":{...} } } 를 채운다.
//   day  = 기준일(직전 완료일) 요약. weeks = 문의 있는 모든 월~일 주 요약(월요일 키).
//   ANTHROPIC_API_KEY : 필수. 없으면 스킵.
//   LOUNGE_MODEL      : 모델 override (기본 claude-opus-5).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || DIR;
const MODEL = process.env.LOUNGE_MODEL || 'claude-opus-5';
const KEY = process.env.ANTHROPIC_API_KEY;
const PROJ_FILTER = process.env.PROJECT;

if (!KEY) { console.log('ℹ 고객센터 요약 스킵 (ANTHROPIC_API_KEY 미설정)'); process.exit(0); }

const dbPath = join(DATA_DIR, 'data.json');
const db = JSON.parse(readFileSync(dbPath, 'utf8'));
const cfg = JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf8'));

const SYSTEM = `당신은 게임 고객지원(CS) 애널리스트입니다. 지정된 기간의 고객센터 문의를 분석해 운영진용 요약을 만듭니다.
반드시 아래 JSON 스키마에 정확히 맞는 JSON만 출력하세요(설명·마크다운·코드펜스 없이).

{
  "gist": { "ko": "해당 기간 문의 현황·주요 유형·처리 상황을 1~3문장으로.", "zh": "중국어 번역" },
  "topics": [ { "name": {"ko":"문의 유형/이슈명","zh":"中文"}, "note": {"ko":"한줄 설명(건수·처리상태 포함)","zh":"中文"}, "tone": "pos|neg|neu" } ]
}
규칙:
- topics는 1~4개(문의 건수에 맞게). 미처리/지연 이슈는 neg, 처리된 건 pos, 일반 문의는 neu.
- 개인정보(이름·이메일·연락처)는 넣지 말 것. 유형·건수·처리상태 중심.
- 운영 보고 톤, 사실 위주. 주어진 문의만 근거로.`;

function buildInput(items, periodLabel, game) {
  const cat = {}; items.forEach(i => { const c = i.category || '미분류'; cat[c] = (cat[c] || 0) + 1; });
  const catStr = Object.entries(cat).map(([k, v]) => `${k} ${v}`).join(', ');
  const list = items.slice(0, 120).map(i => `- [${i.category || '미분류'}·${i.status}] ${i.subject || ''}${i.summary ? ' — ' + i.summary : ''} (접수 ${i.created}${i.resolved ? ', 처리 ' + i.resolved : ''})`);
  return `게임: ${game}\n기간: ${periodLabel}\n문의 ${items.length}건 · 분류: ${catStr}\n\n=== 문의 목록 ===\n${list.join('\n')}`;
}

async function summarize(client, items, periodLabel, game) {
  if (!items.length) return { count: 0 };
  const resp = await client.messages.create({
    model: MODEL, max_tokens: 3000,
    thinking: { type: 'adaptive' }, output_config: { effort: 'medium' },
    system: SYSTEM, messages: [{ role: 'user', content: buildInput(items, periodLabel, game) }],
  });
  const txt = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const jsonStr = txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1);
  const out = JSON.parse(jsonStr);
  return { count: items.length, gist: out.gist, topics: out.topics || [] };
}

// 대시보드 buildWeeks와 동일한 월~일 주 버킷 (일자 키 기준)
function weeksOf(dates) {
  const out = [];
  const first = new Date(dates[0] + 'T00:00:00Z');
  first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));
  const last = new Date(dates[dates.length - 1] + 'T00:00:00Z');
  const cur = new Date(first);
  while (cur <= last) {
    const mon = cur.toISOString().slice(0, 10);
    const sd = new Date(cur); sd.setUTCDate(sd.getUTCDate() + 6);
    const sun = sd.toISOString().slice(0, 10);
    if (dates.some(d => d >= mon && d <= sun)) out.push({ mon, sun });
    cur.setUTCDate(cur.getUTCDate() + 7);
  }
  return out;
}

async function summarizeProject(proj) {
  const p = db.projects[proj.id];
  const cs = p?.cs;
  if (!cs || !(cs.inquiries || [])) { console.log(`  [${proj.id}] CS 데이터 없음 → 스킵`); return; }
  const inq = cs.inquiries || [];
  const dates = Object.keys(p.days).sort();
  const game = proj.helpdeskGame || proj.name;
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: KEY });
  // 일간: 기준일(직전 완료일)만 AI 요약
  const dayRef = dates[dates.length - 2] || dates[dates.length - 1];
  const dayItems = inq.filter(i => i.created === dayRef);
  const day = { date: dayRef, ...(await summarize(client, dayItems, dayRef, game)) };
  // 주간: 문의가 있는 모든 주에 AI 요약 (mon 키), 빈 주는 count:0만 저장
  const weeks = {};
  for (const w of weeksOf(dates)) {
    const items = inq.filter(i => i.created >= w.mon && i.created <= w.sun);
    weeks[w.mon] = items.length
      ? { from: w.mon, to: w.sun, ...(await summarize(client, items, `${w.mon}~${w.sun}`, game)) }
      : { from: w.mon, to: w.sun, count: 0 };
  }
  p.cs.summary = { day, weeks, generatedAt: new Date().toISOString(), model: MODEL };
  const wkDone = Object.values(weeks).filter(w => w.count > 0).length;
  console.log(`  ✓ [${proj.id}] 고객센터 요약 — 기준일 ${dayRef}: ${day.count}건 / 주간 요약 ${wkDone}개 생성`);
}

for (const proj of (cfg.projects || [])) {
  if (PROJ_FILTER && proj.id !== PROJ_FILTER) continue;
  if (!proj.helpdesk) continue;
  try { await summarizeProject(proj); } catch (e) { console.error(`  ✗ [${proj.id}] CS 요약 실패: ${e.message}`); }
}
writeFileSync(dbPath, JSON.stringify(db, null, 2));
console.log('✅ 고객센터 요약 완료 → data.json 갱신');

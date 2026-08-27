// 고객센터 AI 요약 — cs.inquiries(문의 목록)를 Claude로 요약해 문의 현황·처리내용 gist 생성.
// helpdesk=true 프로젝트의 db.projects[id].cs.summary 를 채운다.
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

const SYSTEM = `당신은 게임 고객지원(CS) 애널리스트입니다. 고객센터 문의 데이터를 분석해 운영진용 요약을 만듭니다.
반드시 아래 JSON 스키마에 정확히 맞는 JSON만 출력하세요(설명·마크다운·코드펜스 없이).

{
  "gist": { "ko": "최근 문의 현황·주요 유형·처리 상황을 2~3문장으로. 문의량/처리량 흐름과 두드러진 이슈 중심.", "zh": "중국어 번역" },
  "topics": [ { "name": {"ko":"문의 유형/이슈명","zh":"中文"}, "note": {"ko":"한줄 설명(건수·처리상태 포함)","zh":"中文"}, "tone": "pos|neg|neu" } ]
}

규칙:
- topics는 3~5개. 가장 많거나 운영상 중요한 문의 유형·이슈 위주. 미처리/지연 이슈는 neg, 원활히 처리된 건 pos, 일반 문의는 neu.
- 개인정보(이름·이메일·연락처)는 요약에 넣지 말 것. 유형·건수·처리상태 중심으로.
- 운영 보고 톤, 사실 위주.`;

function buildInput(cs, game) {
  const totCreated = (cs.daily || []).reduce((s, d) => s + (d.created || 0), 0);
  const totResolved = (cs.daily || []).reduce((s, d) => s + (d.resolved || 0), 0);
  const cat = Object.entries(cs.byCategory || {}).map(([k, v]) => `${k} ${v}`).join(', ');
  const st = Object.entries(cs.byStatus || {}).map(([k, v]) => `${k} ${v}`).join(', ');
  const items = (cs.inquiries || []).slice(0, 120).map(i =>
    `- [${i.category || '미분류'}·${i.status}] ${i.subject || ''}${i.summary ? ' — ' + i.summary : ''} (접수 ${i.created}${i.resolved ? ', 처리 ' + i.resolved : ''})`);
  return { text: `게임: ${game}\n최근 30일 문의 ${totCreated}건 · 처리 ${totResolved}건\n분류 분포: ${cat}\n상태 분포: ${st}\n\n=== 문의 목록(최신순) ===\n${items.join('\n')}`, basedOn: (cs.inquiries || []).length };
}

async function summarizeProject(proj) {
  const p = db.projects[proj.id];
  const cs = p?.cs;
  if (!cs || !(cs.inquiries || []).length) { console.log(`  [${proj.id}] CS 데이터 없음 → 스킵`); return; }
  const { text, basedOn } = buildInput(cs, proj.helpdeskGame || proj.name);
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: KEY });
  const resp = await client.messages.create({
    model: MODEL, max_tokens: 4000,
    thinking: { type: 'adaptive' }, output_config: { effort: 'medium' },
    system: SYSTEM, messages: [{ role: 'user', content: text }],
  });
  const txt = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const jsonStr = txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1);
  let out;
  try { out = JSON.parse(jsonStr); } catch (e) { console.error(`  ✗ [${proj.id}] CS 요약 JSON 파싱 실패: ${e.message}`); return; }
  p.cs.summary = { gist: out.gist, topics: out.topics || [], generatedAt: new Date().toISOString(), model: MODEL, basedOn };
  console.log(`  ✓ [${proj.id}] 고객센터 요약 생성 (분석 ${basedOn}건, 주제 ${(out.topics || []).length}개)`);
}

for (const proj of (cfg.projects || [])) {
  if (PROJ_FILTER && proj.id !== PROJ_FILTER) continue;
  if (!proj.helpdesk) continue;
  try { await summarizeProject(proj); } catch (e) { console.error(`  ✗ [${proj.id}] CS 요약 실패: ${e.message}`); }
}
writeFileSync(dbPath, JSON.stringify(db, null, 2));
console.log('✅ 고객센터 요약 완료 → data.json 갱신');

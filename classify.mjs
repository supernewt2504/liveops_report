// 리뷰 감성·주제 자동 분류 (자동화용) — Anthropic API 사용
// 준비: npm i @anthropic-ai/sdk  &&  export ANTHROPIC_API_KEY=...
// 사용: node classify.mjs   → data.json 의 미분류(topic=null) 리뷰만 분류해 채움
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const dbPath = join(DIR, 'data.json');
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

if (!pending.length) { console.log('분류할 신규 리뷰 없음.'); process.exit(0); }
console.log('미분류 리뷰:', pending.length, '건');

if (!process.env.ANTHROPIC_API_KEY) {
  console.log('⚠ ANTHROPIC_API_KEY 없음 → 분류 건너뜀 (대시보드는 별점 기반 감성으로 표시). 자동분류하려면 키 설정 후 재실행.');
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

writeFileSync(dbPath, JSON.stringify(db, null, 2));
console.log('완료 → data.json 갱신');

// 일일 리포트 스케줄러 — 매일 KST 11:00 에 파이프라인 1회 실행.
// 재시작에도 하루 중복 실행/중복 메일을 막기 위해 마지막 실행 날짜를 볼륨(state 파일)에 기록.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runPipeline, runRankPeak } from '../lib/pipeline.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.DATA_DIR || ROOT;
const STATE = join(DATA_DIR, '.last-report');       // 마지막 성공 실행의 KST 날짜(YYYY-MM-DD)

const TARGET_HOUR = Number(process.env.REPORT_HOUR_KST || 11);
const CHECK_MS = 60 * 1000;
// 일중 순위 피크 수집 시각(KST). 이 시각들마다 구글/애플 순위를 조회해 그날 최고 순위를 기록.
const PEAK_HOURS = (process.env.RANK_PEAK_HOURS || '13,15,17,19,21,23').split(',').map(s => parseInt(s.trim(), 10)).filter(h => !isNaN(h));

const kstNow = () => new Date(Date.now() + 9 * 3600 * 1000);
const kstDate = (d = kstNow()) => d.toISOString().slice(0, 10);

let lastRun = existsSync(STATE) ? readFileSync(STATE, 'utf8').trim() : null;
let running = false;
let peakRunning = false;
let lastPeakSlot = null;

async function tick() {
  if (running || peakRunning) return;
  const now = kstNow();
  const today = kstDate(now);
  if (lastRun === today) return;                    // 오늘분 이미 완료
  if (now.getUTCHours() < TARGET_HOUR) return;      // 아직 목표 시각 전
  running = true;
  try {
    console.log(`⏱  ${today} — 리포트 파이프라인 시작 (목표 ${TARGET_HOUR}:00 KST)`);
    await runPipeline({ mail: true });
    lastRun = today;
    try { writeFileSync(STATE, today); } catch (e) { console.error('상태 기록 실패:', e.message); }
  } catch (e) {
    console.error('✗ 파이프라인 실패 (다음 체크에 재시도):', e.message);
  } finally {
    running = false;
  }
}

// 일중 순위 피크: PEAK_HOURS 시각마다 1회씩 구글/애플 순위 조회 → 그날 최고 순위 갱신 + 대시보드 재빌드 (메일 없음).
async function peakTick() {
  if (running || peakRunning) return;               // 전체 파이프라인/이전 피크와 겹치지 않게
  const now = kstNow();
  const h = now.getUTCHours();
  if (!PEAK_HOURS.includes(h)) return;
  const slot = kstDate(now) + 'T' + h;
  if (lastPeakSlot === slot) return;                // 같은 시간대 중복 방지
  lastPeakSlot = slot;
  peakRunning = true;
  try { console.log(`⏱  순위 피크 수집 (${slot} KST)`); await runRankPeak(); }
  catch (e) { console.error('✗ 순위 피크 실패:', e.message); }
  finally { peakRunning = false; }
}

export function startScheduler() {
  console.log(`⏱  스케줄러 시작 — 매일 ${TARGET_HOUR}:00 KST 발송 · 순위 피크 ${PEAK_HOURS.join('/')}시 KST · 마지막 실행: ${lastRun || '없음'}`);
  tick();                                           // 부팅 시점이 목표시각 이후이고 오늘 미실행이면 즉시 실행
  setInterval(tick, CHECK_MS);
  return setInterval(peakTick, CHECK_MS);
}

// 단독 워커로 실행할 때
if (import.meta.url === `file://${process.argv[1]}`) startScheduler();

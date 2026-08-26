// game-ops 리포트 서버 — 토큰 링크로 대시보드 열람 + 같은 컨테이너에서 일일 스케줄러 구동.
//   GET /health            헬스체크
//   GET /r/:proj?t=TOKEN   토큰이 맞으면 해당 프로젝트 대시보드 HTML 서빙 (&lang=zh 로 중문)
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { startScheduler } from '../worker/scheduler.mjs';
import { runPipeline } from '../lib/pipeline.mjs';
import { backupToDrive, driveEnabled } from '../lib/gdrive-backup.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.DATA_DIR || ROOT;          // 대시보드 산출물 위치(볼륨)
const TOKEN = process.env.REPORT_TOKEN || '';           // 리포트 열람 토큰

const cfg = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const PROJECTS = new Set((cfg.projects || []).map(p => p.id));
const FIRST = (cfg.projects || [])[0]?.id;

// 타이밍 공격 방지용 상수시간 토큰 비교
function tokenOk(given) {
  if (!TOKEN || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const app = express();
app.disable('x-powered-by');

app.get('/health', (req, res) => res.json({ ok: true, projects: [...PROJECTS] }));

app.get('/r/:proj', (req, res) => {
  const { proj } = req.params;
  if (!PROJECTS.has(proj)) return res.status(404).send('알 수 없는 프로젝트입니다.');
  if (!tokenOk(req.query.t)) return res.status(401).send('접근 토큰이 유효하지 않습니다.');

  const base = proj === FIRST ? 'dashboard' : `dashboard-${proj}`;
  const lang = req.query.lang === 'zh' ? '-zh' : '';
  // 수신자 바 없는 web(-mail) 버전 우선, 없으면 폴백
  const cands = [`${base}-mail${lang}.html`, `${base}${lang}.html`, `${base}-mail.html`, `${base}.html`];
  const file = cands.map(f => path.join(DATA_DIR, f)).find(existsSync);
  if (!file) return res.status(503).send('아직 리포트가 생성되지 않았습니다. 잠시 후 다시 시도해 주세요.');

  res.set('Cache-Control', 'no-store');
  res.sendFile(file);
});

// ---- 관리용 수동 트리거 (토큰 필요) ----
// 드라이브 백업만 즉시 실행 (data.json·대시보드가 이미 있어야 함)
app.get('/admin/backup', async (req, res) => {
  if (!tokenOk(req.query.t)) return res.status(401).json({ error: 'unauthorized' });
  if (!driveEnabled()) return res.status(400).json({ ok: false, error: 'GOOGLE_SERVICE_ACCOUNT_JSON/GDRIVE_FOLDER_ID 미설정' });
  try { await backupToDrive(); res.json({ ok: true, msg: '백업 완료 (상세는 Deploy Logs 참고)' }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 전체 파이프라인 수동 실행 (기본 메일 발송, ?mail=0 이면 생략). 즉시 응답 후 백그라운드 실행.
app.get('/admin/run', (req, res) => {
  if (!tokenOk(req.query.t)) return res.status(401).json({ error: 'unauthorized' });
  const mail = req.query.mail !== '0';
  const testTo = req.query.to ? String(req.query.to) : null;   // 지정 시 그 주소로만 발송(테스트)
  res.json({ ok: true, started: true, mail, testTo, msg: '파이프라인 시작 (진행상황은 Deploy Logs 참고)' });
  runPipeline({ mail, testTo }).catch(e => console.error('✗ admin/run 실패:', e.message));
});

app.get('/', (req, res) => res.status(200).send('game-ops report server'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ game-ops report server on :${PORT}`);
  if (!TOKEN) console.warn('⚠ REPORT_TOKEN 미설정 — 모든 리포트 요청이 401 처리됩니다. 환경변수를 설정하세요.');
  if (!process.env.NO_WORKER) startScheduler();     // 같은 컨테이너에서 스케줄러 동시 구동
});

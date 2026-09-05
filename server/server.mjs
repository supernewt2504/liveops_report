// game-ops 리포트 서버 — 토큰 링크로 대시보드 열람 + 같은 컨테이너에서 일일 스케줄러 구동.
//   GET /health            헬스체크
//   GET /r/:proj?t=TOKEN   토큰이 맞으면 해당 프로젝트 대시보드 HTML 서빙 (&lang=zh 로 중문)
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { startScheduler } from '../worker/scheduler.mjs';
import { runPipeline, runRankPeak } from '../lib/pipeline.mjs';
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

// 짧은 코드(a,b,c…) ↔ 프로젝트 매핑. 정식 projId도 그대로 허용.
const CProjects = cfg.projects || [];
// 비밀 슬러그 → projId 매핑 (게임별 고유 비밀 경로. 이걸로 접근하면 토큰 불필요·게임별 분리)
const SLUGS = {};
for (const p of CProjects) if (p.slug) SLUGS[p.slug] = p.id;
function resolveProj(code) {
  if (PROJECTS.has(code)) return code;
  const idx = { a: 0, b: 1, c: 2, d: 3 }[String(code).toLowerCase()];
  return idx != null ? (CProjects[idx]?.id || null) : null;
}
function serveReport(projId, req, res) {
  const base = projId === FIRST ? 'dashboard' : `dashboard-${projId}`;
  const lang = req.query.lang === 'zh' ? '-zh' : '';
  const cands = [`${base}-mail${lang}.html`, `${base}${lang}.html`, `${base}-mail.html`, `${base}.html`];
  const file = cands.map(f => path.join(DATA_DIR, f)).find(existsSync);
  if (!file) return res.status(503).send('아직 리포트가 생성되지 않았습니다. 잠시 후 다시 시도해 주세요.');
  res.set('Cache-Control', 'no-store');
  res.sendFile(file);
}
// 리포트 접근: ①비밀 슬러그(토큰 불필요, 게임별 분리) ②짧은코드/projId(토큰 필요, 내부/하위호환)
function handleReport(key, req, res, next) {
  if (SLUGS[key]) return serveReport(SLUGS[key], req, res);          // 비밀 슬러그 → 그 게임만
  const projId = resolveProj(key);
  if (!projId) return next ? next() : res.status(404).send('알 수 없는 경로입니다.');
  if (!tokenOk(req.query.t)) return res.status(401).send('접근 토큰이 유효하지 않습니다.');
  serveReport(projId, req, res);
}

// /r/:key (슬러그 또는 proj) + 최상위 /:key (아래) 지원
app.get('/r/:key', (req, res) => handleReport(req.params.key, req, res, null));

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
  const mailProject = req.query.project ? String(req.query.project) : null; // 지정 시 해당 프로젝트만 발송(테스트)
  res.json({ ok: true, started: true, mail, testTo, mailProject, msg: '파이프라인 시작 (진행상황은 Deploy Logs 참고)' });
  runPipeline({ mail, testTo, mailProject }).catch(e => console.error('✗ admin/run 실패:', e.message));
});

// 일중 순위 피크 즉시 갱신(수집·요약·메일 없이 순위만 조회→최고순위 반영→대시보드 재빌드)
app.get('/admin/peak', (req, res) => {
  if (!tokenOk(req.query.t)) return res.status(401).json({ error: 'unauthorized' });
  res.json({ ok: true, started: true, msg: '순위 피크 수집 시작 (진행상황은 Deploy Logs 참고)' });
  runRankPeak().catch(e => console.error('✗ admin/peak 실패:', e.message));
});

// 최상위 경로: /jszx-… (비밀 슬러그) · /a · /b (알 수 없으면 통과 → 404)
app.get('/:key', (req, res, next) => handleReport(req.params.key, req, res, next));

app.get('/', (req, res) => res.status(200).send('game-ops report server'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ game-ops report server on :${PORT}`);
  if (!TOKEN) console.warn('⚠ REPORT_TOKEN 미설정 — 모든 리포트 요청이 401 처리됩니다. 환경변수를 설정하세요.');
  if (!process.env.NO_WORKER) startScheduler();     // 같은 컨테이너에서 스케줄러 동시 구동
});

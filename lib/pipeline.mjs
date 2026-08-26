// 리포트 파이프라인: 수집 → (분류) → 프로젝트별 대시보드 빌드 → (메일)
// 스케줄러(worker/scheduler.mjs)와 수동 실행(node lib/pipeline.mjs) 양쪽에서 사용.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { backupToDrive } from './gdrive-backup.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function step(name, file, env = {}, optional = false) {
  console.log(`\n━━ ${name} ━━`);
  try {
    execFileSync('node', [join(ROOT, file)], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
    return true;
  } catch (e) {
    console.error(`✗ ${name} 실패${optional ? ' (건너뜀)' : ''}: ${e.message}`);
    if (!optional) throw e;
    return false;
  }
}

export async function runPipeline({ mail = true } = {}) {
  step('1 수집 (스토어 순위·리뷰·평점 + 시트)', 'collect.mjs');            // 전 프로젝트 일괄
  step('2 리뷰 감성·주제 분류', 'classify.mjs', {}, true);                  // 키 없으면 자동 스킵
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
  for (const p of (cfg.projects || [])) step(`3 대시보드 빌드 [${p.id}]`, 'build-dashboard.mjs', { PROJECT: p.id });
  console.log('\n━━ 4 구글드라이브 백업 ━━');
  try { await backupToDrive(); } catch (e) { console.error('✗ 드라이브 백업 실패 (건너뜀):', e.message); }
  if (mail) step('5 리포트 메일 발송', 'send-mail.mjs', {}, true);          // 자격증명/수신자 없으면 스킵
  console.log('\n✅ 파이프라인 완료');
}

// 단독 실행: node lib/pipeline.mjs  (MAIL=0 이면 메일 생략)
if (import.meta.url === `file://${process.argv[1]}`) {
  runPipeline({ mail: process.env.MAIL !== '0' }).catch(e => { console.error(e); process.exit(1); });
}

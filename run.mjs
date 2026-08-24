// 일일 파이프라인 러너: collect → classify → build
// 사용: node run.mjs
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
function step(name, file, optional = false) {
  console.log(`\n━━ ${name} ━━`);
  try {
    execFileSync('node', [join(DIR, file)], { cwd: DIR, stdio: 'inherit' });
    return true;
  } catch (e) {
    console.error(`✗ ${name} 실패${optional ? ' (건너뜀)' : ''}: ${e.message}`);
    return optional; // 필수 단계 실패 시 false
  }
}

const ok1 = step('1/3 수집 (스토어 순위·리뷰·평점 + 시트 순위)', 'collect.mjs');
step('2/3 리뷰 감성·주제 분류 (신규만)', 'classify.mjs', true); // 키 없으면 자동 스킵
const ok3 = step('3/3 대시보드 빌드', 'build-dashboard.mjs');

console.log(`\n${ok1 && ok3 ? '✅ 파이프라인 완료 → dashboard.html 갱신됨' : '⚠ 일부 단계 실패 — 로그 확인'}`);
process.exit(ok1 && ok3 ? 0 : 1);

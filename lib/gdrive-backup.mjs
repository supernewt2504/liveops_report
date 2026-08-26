// 구글드라이브 백업 — data.json + 대시보드 HTML을 날짜별 스냅샷으로 지정 폴더에 업로드.
// 서비스 계정(JSON 키) + 대상 폴더 ID 필요. 둘 다 없으면 자동 스킵(no-op).
//   GOOGLE_SERVICE_ACCOUNT_JSON : 서비스 계정 키 JSON 전체(문자열)
//   GDRIVE_FOLDER_ID            : service@ 드라이브에 만든 백업 폴더 ID (서비스 계정에 공유)
import { JWT } from 'google-auth-library';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.DATA_DIR || ROOT;
const SA = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
const FOLDER = process.env.GDRIVE_FOLDER_ID || '';

export const driveEnabled = () => !!(SA && FOLDER);

const kstDate = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

async function tokenClient() {
  const key = JSON.parse(SA);
  const jwt = new JWT({ email: key.client_email, key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/drive.file'] });
  await jwt.authorize();
  return jwt;
}

// 같은 이름 파일이 폴더에 있으면 덮어쓰기(update), 없으면 새로 생성 — 재실행 시 중복 방지.
async function findExisting(token, name) {
  const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}' and '${FOLDER}' in parents and trashed=false`);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&spaces=drive`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const j = await r.json();
  return j.files?.[0]?.id || null;
}

async function uploadOne(jwt, localPath, driveName, mime) {
  const token = (await jwt.getAccessToken()).token;
  const existingId = await findExisting(token, driveName);
  const boundary = 'gopsbnd' + Math.floor((Date.now() % 1e9));
  const meta = existingId ? { name: driveName } : { name: driveName, parents: [FOLDER] };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
    Buffer.from(JSON.stringify(meta)),
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
    readFileSync(localPath),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const url = existingId
    ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart&fields=id,name`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name`;
  const res = await fetch(url, {
    method: existingId ? 'PATCH' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`${driveName} 업로드 실패 ${res.status}: ${await res.text()}`);
  return (await res.json()).name;
}

// 파이프라인에서 호출: data.json + 프로젝트 대시보드를 날짜별로 백업
export async function backupToDrive() {
  if (!driveEnabled()) { console.log('ℹ 구글드라이브 백업 건너뜀 (GOOGLE_SERVICE_ACCOUNT_JSON/GDRIVE_FOLDER_ID 미설정)'); return; }
  const d = kstDate();
  const targets = [
    { file: 'data.json', name: `data_${d}.json`, mime: 'application/json' },
    { file: 'dashboard.html', name: `dashboard_${d}.html`, mime: 'text/html' },
    { file: 'dashboard-projectB.html', name: `dashboard-projectB_${d}.html`, mime: 'text/html' },
  ].filter(t => existsSync(join(DATA_DIR, t.file)));
  if (!targets.length) { console.log('ℹ 백업 대상 파일 없음'); return; }
  const jwt = await tokenClient();
  for (const t of targets) {
    const name = await uploadOne(jwt, join(DATA_DIR, t.file), t.name, t.mime);
    console.log(`  ☁ 드라이브 백업: ${name}`);
  }
  console.log('✅ 구글드라이브 백업 완료');
}

// 단독 실행: node lib/gdrive-backup.mjs
if (import.meta.url === `file://${process.argv[1]}`) {
  backupToDrive().catch(e => { console.error('✗ 백업 실패:', e.message); process.exit(1); });
}

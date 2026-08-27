// 고객센터(helpdesk) 연동 — helpdesk의 토큰 게이트 /api/report 를 호출해 게임별 문의 집계를 가져온다.
//   HELPDESK_API_URL   : helpdesk 공개 베이스 URL (예: https://helpdesk-xxx.up.railway.app)
//   HELPDESK_API_TOKEN : helpdesk의 REPORT_API_TOKEN 과 동일한 값
export const helpdeskEnabled = () => !!(process.env.HELPDESK_API_URL && process.env.HELPDESK_API_TOKEN);

// game: helpdesk의 game 값(예: '부족또전쟁'), from/to: 'YYYY-MM-DD'
export async function fetchCsReport(game, from, to) {
  const base = (process.env.HELPDESK_API_URL || '').replace(/\/$/, '');
  const token = process.env.HELPDESK_API_TOKEN || '';
  if (!base || !token) throw new Error('HELPDESK_API_URL/HELPDESK_API_TOKEN 미설정');
  const url = `${base}/api/report?game=${encodeURIComponent(game)}&from=${from}&to=${to}&t=${encodeURIComponent(token)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`helpdesk /api/report ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json(); // { daily:[{date,created,resolved}], byStatus, byCategory, inquiries:[...] }
}

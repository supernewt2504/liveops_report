// 일일/주간 운영 리포트 이메일 발송 (Gmail SMTP) — 한국어 기본, 특정 수신자 중국어
// - 실행일이 월요일이면 '전주 주간', 그 외 '전일 일간' 리포트. 보고형 서술어.
// - 주간엔 스토어 순위 추이 그래프(PNG 첨부, Gmail 호환).
// - recipients.json 이 {ko:[...], zh:[...]} 이면 언어별로 각각 발송(배열이면 전부 한국어).
// 자격증명(로컬): ~/.gameops-mail.json { "user":"...", "appPassword":"...", "to":"폴백" }
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { gmailApiEnabled, gmailSend, gmailSender } from './lib/gmail-send.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
// 런타임 데이터·대시보드 산출물 위치 (클라우드=/data 볼륨, 로컬=코드 디렉터리)
const DATA_DIR = process.env.DATA_DIR || DIR;
const FROM_NAME = { ko: '부족또전쟁 운영팀', zh: '决胜之心 运营团队' };
// 메일 본문에 넣을 웹 리포트 링크 (둘 다 설정돼야 버튼 표시). 예: https://game-ops.up.railway.app
const REPORT_BASE = (process.env.REPORT_BASE_URL || '').replace(/\/$/, '');
const REPORT_TOKEN = process.env.REPORT_TOKEN || '';

// 발송 방식: Gmail API(서비스계정 위임) 우선 — Railway가 SMTP 차단 시. 아니면 SMTP(로컬).
const USE_GMAIL_API = gmailApiEnabled();
const credPath = join(homedir(), '.gameops-mail.json');
let cred = {};
if (process.env.MAIL_USER && process.env.MAIL_APP_PASSWORD) {
  cred = { user: process.env.MAIL_USER, appPassword: process.env.MAIL_APP_PASSWORD, to: process.env.MAIL_TO || '' };
} else if (existsSync(credPath)) {
  cred = JSON.parse(readFileSync(credPath, 'utf8'));
}
// 발신 주소: Gmail API 모드=GMAIL_SENDER, SMTP 모드=cred.user
const user = USE_GMAIL_API ? gmailSender() : cred.user;
const pass = (cred.appPassword || '').replace(/\s/g, '');
if (!USE_GMAIL_API) {
  if (!user || !pass) {
    console.log('⚠ 메일 자격증명 없음(Gmail API용 GOOGLE_SERVICE_ACCOUNT_JSON+GMAIL_SENDER, 또는 SMTP용 MAIL_USER+MAIL_APP_PASSWORD) → 발송 건너뜀.');
    process.exit(0);
  }
}

const db = JSON.parse(readFileSync(join(DATA_DIR, 'data.json'), 'utf8'));
const projId = Object.keys(db.projects)[0];
const proj = db.projects[projId];
const days = proj.days;
const allDates = Object.keys(days).sort();

// ---- 수신자(언어별) ----
// 클라우드: 환경변수 RECIPIENTS_JSON(프로젝트별 객체 문자열) 우선, 없으면 로컬 recipients.json
const byLang = { ko: [], zh: [] };
try {
  const raw = process.env.RECIPIENTS_JSON
    ? JSON.parse(process.env.RECIPIENTS_JSON)
    : JSON.parse(readFileSync(join(DIR, 'recipients.json'), 'utf8'));
  const rj = raw[projId];
  if (Array.isArray(rj)) byLang.ko = rj.filter(e => /@/.test(e));
  else if (rj && typeof rj === 'object') for (const l of ['ko', 'zh']) if (Array.isArray(rj[l])) byLang[l] = rj[l].filter(e => /@/.test(e));
} catch {}
if (!byLang.ko.length && !byLang.zh.length && cred.to) byLang.ko = [cred.to];
// 테스트 우회: MAIL_TEST_TO 가 있으면 운영 수신자 무시하고 그 주소로만 1통(한국어) 발송
if (process.env.MAIL_TEST_TO) { byLang.ko = [process.env.MAIL_TEST_TO]; byLang.zh = []; console.log('🧪 테스트 발송 모드 →', process.env.MAIL_TEST_TO); }
if (!byLang.ko.length && !byLang.zh.length) { console.error('✗ 수신자 없음'); process.exit(1); }

// ================= 라벨/문구 사전 =================
const T = {
  ko: {
    game: '부족또전쟁', wUnit: '건',
    subjW: (m, s) => `[부족또전쟁] 주간 운영 리포트 (${m} ~ ${s})`,
    subjD: (d, w) => `[부족또전쟁] 일일 운영 리포트 ${d}(${w})`,
    titleW: '🎮 부족또전쟁 주간 운영 리포트', titleD: '🎮 부족또전쟁 일일 운영 리포트',
    metaW: (m, mw, s, sw) => `${m} (${mw}) ~ ${s} (${sw})`,
    metaD: (d, w) => `${d} (${w}) 기준 · 전일 대비`,
    storeBlock: '📊 스토어 지표', loungeBlock: '💬 네이버 라운지',
    subTrend: '스토어 순위 추이 (일자별)', subCum: '누적 지표', subReview: '리뷰·여론', subStore: '스토어 현황',
    subEvents: '진행 · 종료 이벤트', subUser: '유저 게시물 (커뮤니티·고객센터)',
    thStore: '스토어', thFree: '인기 순위', thGross: '매출 순위', thRate: '누적 별점',
    noRank: '순위 없음', rankUnit: '위', noChg: '변동 없음', ongoing: '진행중', ended: '종료',
    noEvents: '해당 기간 진행 중이거나 종료된 이벤트가 없었습니다.',
    noUser: '해당 기간 커뮤니티 게시판 신규 글이 확인되지 않았습니다.',
    wd: ['일', '월', '화', '수', '목', '금', '토'],
    storeNames: { google: '구글플레이', apple: '애플 앱스토어', onestore: '원스토어', galaxy: '갤럭시스토어' },
    chartLabels: { 'onestore-rankFree': '원스토어 인기', 'onestore-rankGrossing': '원스토어 매출', 'galaxy-rankFree': '갤럭시 인기', 'galaxy-rankGrossing': '갤럭시 매출', 'google-rankGrossing': '구글 매출', 'apple-rankGrossing': '애플 매출' },
    chartCap: absent => `※ 세로축은 순위(위로 갈수록 상위).${absent.length ? ` ${absent.join('·')}은 기간 내 순위권 밖/미집계로 선이 없습니다.` : ''}`,
    boardNames: { '자유 게시판': '자유 게시판', '버그 제보': '버그 제보', '질문&답변': '질문&답변', '건의사항': '건의사항', '공략 & TIP': '공략 & TIP' },
    topics: { '칭찬': '칭찬', '콘텐츠': '콘텐츠', '계정/로그인': '계정/로그인', '과금': '과금', '뽑기/확률': '뽑기/확률', '버그/접속': '버그/접속', '편의성': '편의성', '보상/리워드': '보상/리워드', '기타': '기타', '미분류': '미분류' },
    viewWeb: '웹에서 리포트 보기',
    viewWebSub: '버튼을 누르면 웹에서 전체 지표·리뷰·라운지 여론(일간/주간·한/중)을 확인할 수 있습니다.',
    linkbox: '📎 상세 지표·리뷰·라운지 여론은 <b>첨부된 대시보드 HTML</b>을 브라우저로 열어 확인해 주세요.',
    foot: '자동 발송 · 부족또전쟁 운영 대시보드 파이프라인',
    leadW: (a, b, c, d) => `지난주 원스토어 순위는 인기 ${a}·매출 ${b}에서 시작해 주말에는 <b>인기 ${c}·매출 ${d}</b>를 기록했습니다. 구글·애플은 순위권 밖을 유지했습니다.`,
    cum: (gs, gc, as, ac) => `누적 별점은 구글 ${gs}(${gc}건)·애플 ${as}(${ac}건)로 집계되었습니다.`,
    reviewW: (n, pn, rd, pos, neg, negW, negP) => `주간 신규 리뷰는 <b>${n}건</b>으로 전주(${pn}건) 대비 ${rd}했습니다. 긍정 ${pos}건·부정 ${neg}건으로 부정 비중은 전주 ${negP}%에서 <b>${negW}%</b>였습니다.`,
    rdInc: x => `${x}% 증가`, rdDec: x => `${x}% 감소`, rdSame: '동일',
    topNeg: (t, c) => `가장 많이 제기된 부정 주제는 <b>${t}</b>(${c}건)였습니다.`,
    leadD: (md, f, g, df, dg) => `${md} 원스토어 순위는 <b>인기 ${f}·매출 ${g}</b>로, 전일 대비 각각 ${df}·${dg} 이동했습니다. 구글·애플은 순위권 밖을 유지했습니다.`,
    reviewD: (n, p, ng, tn) => `당일 신규 리뷰는 <b>${n}건</b>(긍정 ${p}건·부정 ${ng}건)이었습니다.${tn ? ` 부정 리뷰 중에서는 <b>${tn[0]}</b> 관련 의견(${tn[1]}건)이 가장 많았습니다.` : ''}`,
  },
  zh: {
    game: '决胜之心', wUnit: '条',
    subjW: (m, s) => `[决胜之心] 周运营报告 (${m} ~ ${s})`,
    subjD: (d, w) => `[决胜之心] 日运营报告 ${d}(${w})`,
    titleW: '🎮 决胜之心 周运营报告', titleD: '🎮 决胜之心 日运营报告',
    metaW: (m, mw, s, sw) => `${m} (${mw}) ~ ${s} (${sw})`,
    metaD: (d, w) => `${d} (${w}) 基准 · 较前日`,
    storeBlock: '📊 商店指标', loungeBlock: '💬 NAVER 论坛',
    subTrend: '商店排名趋势 (每日)', subCum: '累计指标', subReview: '评论·舆情', subStore: '商店概况',
    subEvents: '进行 · 结束活动', subUser: '用户帖子 (社区·客服)',
    thStore: '商店', thFree: '人气排名', thGross: '畅销排名', thRate: '累计评分',
    noRank: '无排名', rankUnit: '名', noChg: '持平', ongoing: '进行中', ended: '已结束',
    noEvents: '该期间没有进行中或已结束的活动。',
    noUser: '该期间未发现社区板块的新帖。',
    wd: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
    storeNames: { google: 'Google Play', apple: 'App Store', onestore: 'ONE Store', galaxy: 'Galaxy Store' },
    chartLabels: { 'onestore-rankFree': 'ONE Store 人气', 'onestore-rankGrossing': 'ONE Store 畅销', 'galaxy-rankFree': 'Galaxy 人气', 'galaxy-rankGrossing': 'Galaxy 畅销', 'google-rankGrossing': 'Google 畅销', 'apple-rankGrossing': 'Apple 畅销' },
    chartCap: absent => `※ 纵轴为排名(越靠上排名越高)。${absent.length ? ` ${absent.join('·')} 因榜单外/未采集而无折线。` : ''}`,
    boardNames: { '자유 게시판': '自由板', '버그 제보': 'BUG反馈', '질문&답변': '问答', '건의사항': '建议', '공략 & TIP': '攻略&TIP' },
    topics: { '칭찬': '好评', '콘텐츠': '内容', '계정/로그인': '账号/登录', '과금': '付费', '뽑기/확률': '抽卡/概率', '버그/접속': 'BUG/连接', '편의성': '易用性', '보상/리워드': '奖励', '기타': '其他', '미분류': '未分类' },
    viewWeb: '在网页查看报告',
    viewWebSub: '点击按钮即可在网页查看完整指标·评论·论坛舆情(日报/周报·中/韩)。',
    linkbox: '📎 详细指标·评论·论坛舆情请打开<b>附件仪表板 HTML</b>查看。',
    foot: '自动发送 · 决胜之心 运营仪表板流程',
    leadW: (a, b, c, d) => `上周 ONE Store 排名从人气 ${a}·畅销 ${b} 开始，周末为 <b>人气 ${c}·畅销 ${d}</b>。Google·Apple 维持在榜单外。`,
    cum: (gs, gc, as, ac) => `累计评分为 Google ${gs}(${gc}条)·Apple ${as}(${ac}条)。`,
    reviewW: (n, pn, rd, pos, neg, negW, negP) => `本周新增评论 <b>${n}条</b>，较上周(${pn}条)${rd}。好评 ${pos}条·差评 ${neg}条，差评占比由上周 ${negP}% 变为 <b>${negW}%</b>。`,
    rdInc: x => `增加 ${x}%`, rdDec: x => `减少 ${x}%`, rdSame: '持平',
    topNeg: (t, c) => `最多的差评主题是 <b>${t}</b>(${c}条)。`,
    leadD: (md, f, g, df, dg) => `${md} ONE Store 排名为 <b>人气 ${f}·畅销 ${g}</b>，较前日分别 ${df}·${dg}。Google·Apple 维持在榜单外。`,
    reviewD: (n, p, ng, tn) => `当日新增评论 <b>${n}条</b>(好评 ${p}条·差评 ${ng}条)。${tn ? ` 差评中 <b>${tn[0]}</b> 相关意见(${tn[1]}条)最多。` : ''}`,
  },
};

// ---- 공통 데이터 유틸 ----
const st = (dt, k) => (days[dt]?.stores?.[k]) || {};
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dlt = (c, p) => (c == null || p == null) ? '' : (p - c > 0 ? `▲${p - c}` : p - c < 0 ? `▼${c - p}` : '—');
function reviewsOf(dts) { const o = []; for (const dt of dts) for (const k of ['google', 'apple']) for (const r of (st(dt, k).reviews || [])) o.push(r); return o; }
function senti(rs) { let pos = 0, neu = 0, neg = 0; const nt = {}; for (const r of rs) { const se = r.sentiment || ((r.score ?? r.sc) >= 4 ? '긍정' : (r.score ?? r.sc) <= 2 ? '부정' : '중립'); if (se === '긍정') pos++; else if (se === '부정') { neg++; const tp = r.topic || r.tp; if (tp) nt[tp] = (nt[tp] || 0) + 1; } else neu++; } return { pos, neu, neg, nt, tot: pos + neu + neg }; }
let LO = null; for (const d of allDates.slice().reverse()) { if (days[d].lounge?.summary) { LO = days[d].lounge; break; } }

const C = { ink: '#161b26', ink2: '#414b5e', ink3: '#6b7688', bd: '#e6eaf1', bg: '#f6f8fc', good: '#0f8a4c', bad: '#c62a3b' };
const STORE = { col: '#2555d6', bg: '#eef2fd' }, LOUNGE = { col: '#0f8a4c', bg: '#e8f6ee' };

// ================= 리포트 빌더 (언어별) =================
async function buildReport(lang) {
  const L = T[lang];
  const wd = d => L.wd[new Date(d).getUTCDay()];
  const rk = v => v == null ? L.noRank : v + L.rankUnit;
  const wrap = inner => `<div style="font:14px/1.65 -apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;color:${C.ink};max-width:660px;margin:0 auto;padding:4px">${inner}</div>`;
  const h2 = t => `<h2 style="margin:0 0 2px;font-size:19px;letter-spacing:-.02em">${t}</h2>`;
  const meta = t => `<div style="color:${C.ink3};font-size:12px;margin-bottom:16px">${t}</div>`;
  const sub = t => `<div style="font-size:12.5px;font-weight:700;color:${C.ink};margin:16px 0 8px">${t}</div>`;
  const p = t => `<p style="margin:0 0 10px;color:${C.ink2}">${t}</p>`;
  const block = (title, tcol, tbg, inner) => `<div style="border:1px solid ${C.bd};border-radius:12px;margin:14px 0;overflow:hidden"><div style="background:${tbg};padding:10px 16px;font-weight:700;font-size:14px;color:${tcol}">${title}</div><div style="padding:2px 16px 12px">${inner}</div></div>`;
  // 웹 리포트 링크(토큰)가 설정돼 있으면 버튼 노출 + 첨부 안내는 보조로. 없으면 기존 첨부 안내만.
  const webLink = (REPORT_BASE && REPORT_TOKEN)
    ? `${REPORT_BASE}/r/${projId}?t=${encodeURIComponent(REPORT_TOKEN)}${lang === 'zh' ? '&lang=zh' : ''}` : null;
  const linkbox = webLink
    ? `<div style="margin:20px 0 6px"><a href="${webLink}" style="display:inline-block;background:${STORE.col};color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">${L.viewWeb} →</a><div style="margin-top:9px;color:${C.ink3};font-size:12px">${L.viewWebSub}</div></div>`
    : `<div style="margin:20px 0 6px;padding:11px 14px;background:${C.bg};border-radius:8px;color:${C.ink2};font-size:13px">${L.linkbox}</div>`;
  const foot = `<div style="color:#9aa4b2;font-size:11px;border-top:1px solid ${C.bd};padding-top:10px;margin-top:16px">${L.foot}</div>`;

  const storeTable = (dt, pdt) => {
    let rows = '';
    for (const k of ['google', 'apple', 'onestore', 'galaxy']) {
      const s = st(dt, k), ps = st(pdt, k);
      const cell = (v, d) => `<td style="padding:7px 10px;border-bottom:1px solid ${C.bd};text-align:center">${rk(v)}${d ? ` <span style="color:${d[0] === '▲' ? C.good : d[0] === '▼' ? C.bad : C.ink3};font-size:12px">${d}</span>` : ''}</td>`;
      rows += `<tr><td style="padding:7px 10px;border-bottom:1px solid ${C.bd}">${L.storeNames[k]}</td>${cell(s.rankFree, dlt(s.rankFree, ps.rankFree))}${cell(s.rankGrossing, dlt(s.rankGrossing, ps.rankGrossing))}<td style="padding:7px 10px;border-bottom:1px solid ${C.bd};text-align:center">${s.overallScore != null ? '★' + s.overallScore.toFixed(2) : '-'}</td></tr>`;
    }
    return `<table style="border-collapse:collapse;width:100%;font-size:13px;border:1px solid ${C.bd};border-radius:8px;overflow:hidden"><tr style="background:${C.bg}"><th style="padding:7px 10px;text-align:left">${L.thStore}</th><th style="padding:7px 10px">${L.thFree}</th><th style="padding:7px 10px">${L.thGross}</th><th style="padding:7px 10px">${L.thRate}</th></tr>${rows}</table>`;
  };

  const buildRankChart = week => {
    const series = [
      { key: 'onestore', metric: 'rankFree', color: '#e5352b' }, { key: 'onestore', metric: 'rankGrossing', color: '#f59e0b' },
      { key: 'galaxy', metric: 'rankFree', color: '#7c3aed' }, { key: 'galaxy', metric: 'rankGrossing', color: '#1d4ed8' },
      { key: 'google', metric: 'rankGrossing', color: '#00875a' }, { key: 'apple', metric: 'rankGrossing', color: '#4b5563' },
    ].map(s => ({ ...s, id: `${s.key}-${s.metric}`, label: L.chartLabels[`${s.key}-${s.metric}`], vals: week.map(dt => st(dt, s.key)[s.metric] ?? null) })).filter(s => s.vals.some(v => v != null));
    const allv = series.flatMap(s => s.vals).filter(v => v != null);
    if (!allv.length) return { hasData: false };
    const vmin = Math.max(1, Math.min(...allv) - 3), vmax = Math.max(...allv) + 3;
    const W = 620, H = 260, padL = 38, padR = 12, padT = 14, padB = 40, iw = W - padL - padR, ih = H - padT - padB;
    const x = i => padL + (week.length === 1 ? iw / 2 : i / (week.length - 1) * iw);
    const y = v => padT + (v - vmin) / (vmax - vmin) * ih;
    const ticks = [...new Set([vmin, Math.round((vmin + vmax) / 2), vmax])];
    const grid = ticks.map(t => `<line x1="${padL}" y1="${y(t).toFixed(1)}" x2="${W - padR}" y2="${y(t).toFixed(1)}" stroke="${C.bd}"/><text x="${padL - 6}" y="${(y(t) + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="${C.ink3}" font-family="monospace">${t}${L.rankUnit}</text>`).join('');
    const xlabels = week.map((dt, i) => `<text x="${x(i).toFixed(1)}" y="${H - padB + 16}" text-anchor="middle" font-size="10" fill="${C.ink3}" font-family="monospace">${dt.slice(5).replace('-', '.')}</text><text x="${x(i).toFixed(1)}" y="${H - padB + 28}" text-anchor="middle" font-size="9" fill="#a7b0bd">${wd(dt)}</text>`).join('');
    const lines = series.map(s => { const pts = s.vals.map((v, i) => v == null ? null : { i, v }).filter(Boolean); const dstr = pts.map((pt, k) => (k ? 'L' : 'M') + x(pt.i).toFixed(1) + ' ' + y(pt.v).toFixed(1)).join(' '); const dots = pts.map(pt => `<circle cx="${x(pt.i).toFixed(1)}" cy="${y(pt.v).toFixed(1)}" r="3" fill="${s.color}"/>`).join(''); return `<path d="${dstr}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>${dots}`; }).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#ffffff"/>${grid}${lines}${xlabels}</svg>`;
    const legend = series.map(s => `<span style="display:inline-block;margin:0 12px 4px 0;font-size:12px;color:${C.ink2}"><span style="display:inline-block;width:11px;height:11px;border-radius:3px;background:${s.color};vertical-align:-1px;margin-right:5px"></span>${s.label}</span>`).join('');
    const absent = Object.values(L.chartLabels).filter(l => !series.some(s => s.label === l));
    return { hasData: true, svg, legend, caption: L.chartCap(absent) };
  };

  const loungeSection = (ps, pe) => {
    if (!LO || !LO.summary) return '';
    const evs = (LO.summary.events || []).filter(e => e.start && e.end && e.start <= pe && e.end >= ps).sort((a, b) => (b.start).localeCompare(a.start));
    const evHtml = evs.length ? evs.map(e => {
      const live = e.end >= allDates[allDates.length - 1], status = live ? L.ongoing : L.ended, col = live ? C.good : C.ink3, bgc = live ? '#dcf3e6' : '#eef1f6';
      const ti = (e.title && (e.title[lang] || e.title.ko)) || '', pe2 = (e.period && (e.period[lang] || e.period.ko)) || '';
      return `<div style="background:${C.bg};border:1px solid ${C.bd};border-left:3px solid ${col};border-radius:8px;padding:9px 12px;margin-bottom:8px"><span style="font-size:11px;font-weight:700;color:${col};background:${bgc};border-radius:999px;padding:2px 8px;margin-right:8px;white-space:nowrap">${status}</span><span style="font-weight:600;color:${C.ink};font-size:13px">${ti}</span> <span style="color:${C.ink3};font-family:monospace;font-size:12px;white-space:nowrap">${pe2}</span></div>`;
    }).join('') : p(L.noEvents);
    const OFFGROUP = new Set(['공식', '인증 이벤트 게시판', '종료된 이벤트']);
    const bf = LO.boardFeeds || {}, bsum = LO.summary.boards || {};
    const rows = [];
    for (const bid in bf) { const b = bf[bid]; if (OFFGROUP.has(b.group)) continue; const cnt = (b.recent || []).filter(f => f.createdKst && f.createdKst >= ps && f.createdKst <= pe).length; const s = bsum[bid]; if (cnt && s) rows.push({ name: b.name, cnt, sum: (s[lang] || s.ko || '') }); }
    rows.sort((a, b) => b.cnt - a.cnt);
    const top = rows.slice(0, 4);
    const userHtml = top.length ? top.map(r => `<div style="background:${C.bg};border:1px solid ${C.bd};border-left:3px solid ${LOUNGE.col};border-radius:8px;padding:9px 12px;margin-bottom:8px"><div style="margin-bottom:4px"><span style="font-weight:700;color:${C.ink};font-size:13px">${L.boardNames[r.name] || r.name}</span><span style="font-size:11px;font-family:monospace;color:${LOUNGE.col};background:${LOUNGE.bg};border-radius:999px;padding:2px 8px;margin-left:6px;white-space:nowrap">${r.cnt}${L.wUnit}</span></div><div style="font-size:12.5px;color:${C.ink2};line-height:1.55">${r.sum}</div></div>`).join('') : p(L.noUser);
    return sub(L.subEvents) + evHtml + sub(L.subUser) + userHtml;
  };

  // 웹 리포트 링크가 있으면 HTML 첨부는 생략(링크로 대체). 없을 때만 대시보드 HTML을 첨부.
  const webLinkOn = !!(REPORT_BASE && REPORT_TOKEN);
  const attachments = [];
  if (!webLinkOn) {
    const cand = lang === 'zh' ? ['dashboard-mail-zh.html', 'dashboard-mail.html', 'dashboard.html'] : ['dashboard-mail.html', 'dashboard.html'];
    const dashFile = cand.find(f => existsSync(join(DATA_DIR, f))) || 'dashboard.html';
    attachments.push({ filename: `${L.game}_dashboard_${allDates[allDates.length - 1]}.html`, path: join(DATA_DIR, dashFile), contentType: 'text/html' });
  }
  let chartPng = null;
  const latest = allDates[allDates.length - 1];
  const isMonday = new Date(latest).getUTCDay() === 1;
  let subject, html;

  if (isMonday) {
    const mon = addDays(latest, -7), sun = addDays(latest, -1);
    const week = []; for (let d = mon; d <= sun; d = addDays(d, 1)) week.push(d);
    const prev = week.map(d => addDays(d, -7));
    const rw = reviewsOf(week), rp = reviewsOf(prev), sw = senti(rw), sp = senti(rp);
    const tn = Object.entries(sw.nt).sort((a, b) => b[1] - a[1])[0];
    const negW = sw.tot ? Math.round(sw.neg / sw.tot * 100) : 0, negP = sp.tot ? Math.round(sp.neg / sp.tot * 100) : 0;
    const revD = rp.length ? Math.round((rw.length - rp.length) / rp.length * 100) : null;
    const rd = revD == null ? '—' : revD < 0 ? L.rdDec(Math.abs(revD)) : revD > 0 ? L.rdInc(revD) : L.rdSame;
    const o0 = st(week[0], 'onestore'), o1 = st(sun, 'onestore'), g = st(latest, 'google'), a = st(latest, 'apple');
    const chart = buildRankChart(week);
    let chartBlock;
    if (chart.hasData) { const { Resvg } = await import('@resvg/resvg-js'); chartPng = new Resvg(chart.svg, { background: 'white', fitTo: { mode: 'width', value: 1240 } }).render().asPng(); attachments.push({ filename: 'rank-trend.png', content: chartPng, cid: 'rankchart' }); chartBlock = `<div style="border:1px solid ${C.bd};border-radius:8px;padding:12px"><img src="cid:rankchart" alt="rank trend" style="width:100%;max-width:620px;display:block"><div style="margin-top:8px">${chart.legend}</div><div style="font-size:11px;color:${C.ink3};margin-top:4px">${chart.caption}</div></div>`; }
    else chartBlock = `<div style="border:1px solid ${C.bd};border-radius:8px;padding:16px;color:${C.ink3};font-size:13px">${lang === 'zh' ? '期间内无采集到的商店排名。' : '기간 내 집계된 스토어 순위가 없습니다.'}</div>`;

    const tnl = tn ? [L.topics[tn[0]] || tn[0], tn[1]] : null;
    const storeInner = p(L.leadW(rk(o0.rankFree), rk(o0.rankGrossing), rk(o1.rankFree), rk(o1.rankGrossing)))
      + sub(L.subTrend) + chartBlock
      + sub(L.subCum) + p(L.cum(g.overallScore != null ? g.overallScore.toFixed(2) : '-', (g.totalRatings || 0).toLocaleString('en-US'), a.overallScore != null ? a.overallScore.toFixed(2) : '-', a.totalRatings || 0))
      + sub(L.subReview) + p(L.reviewW(rw.length, rp.length, rd, sw.pos, sw.neg, negW, negP))
      + (tnl ? p(L.topNeg(tnl[0], tnl[1])) : '');
    const loungeInner = loungeSection(mon, sun);
    subject = L.subjW(mon, sun);
    html = wrap(h2(L.titleW) + meta(L.metaW(mon, wd(mon), sun, wd(sun)))
      + block(L.storeBlock, STORE.col, STORE.bg, storeInner)
      + (loungeInner ? block(L.loungeBlock, LOUNGE.col, LOUNGE.bg, loungeInner) : '') + linkbox + foot);
  } else {
    const reportDate = allDates[allDates.length - 2] || latest;
    const pdt = allDates[allDates.indexOf(reportDate) - 1];
    const o = st(reportDate, 'onestore'), po = st(pdt, 'onestore');
    const s = senti(reviewsOf([reportDate])), tn = Object.entries(s.nt).sort((a, b) => b[1] - a[1])[0];
    const tnl = tn ? [L.topics[tn[0]] || tn[0], tn[1]] : null;
    const storeInner = p(L.leadD(reportDate.slice(5).replace('-', '.'), rk(o.rankFree), rk(o.rankGrossing), dlt(o.rankFree, po?.rankFree) || L.noChg, dlt(o.rankGrossing, po?.rankGrossing) || L.noChg))
      + sub(L.subStore) + storeTable(reportDate, pdt)
      + sub(L.subReview) + p(L.reviewD(s.tot, s.pos, s.neg, tnl));
    const loungeInner = loungeSection(reportDate, reportDate);
    subject = L.subjD(reportDate, wd(reportDate));
    html = wrap(h2(L.titleD) + meta(L.metaD(reportDate, wd(reportDate)))
      + block(L.storeBlock, STORE.col, STORE.bg, storeInner)
      + (loungeInner ? block(L.loungeBlock, LOUNGE.col, LOUNGE.bg, loungeInner) : '') + linkbox + foot);
  }
  return { subject, html, attachments, chartPng };
}

// ================= 발송 =================
const jobs = [];
for (const lang of ['ko', 'zh']) if (byLang[lang].length) jobs.push({ lang, to: byLang[lang].join(', ') });

if (process.env.MAIL_DRYRUN) {
  for (const j of jobs) {
    const r = await buildReport(j.lang);
    const preview = r.chartPng ? r.html.replace('cid:rankchart', `data:image/png;base64,${r.chartPng.toString('base64')}`) : r.html;
    writeFileSync(join(DIR, `_mail-preview-${j.lang}.html`), preview);
    console.log(`[DRYRUN ${j.lang}] 보낸사람: ${FROM_NAME[j.lang]} <${user}>\n   받는사람: ${FROM_NAME[j.lang]} <${user}> · 숨은참조(BCC): ${j.to}\n   제목: ${r.subject}\n   미리보기 → _mail-preview-${j.lang}.html`);
  }
  process.exit(0);
}

// 발송 함수: Gmail API 모드면 HTTP 발송, 아니면 SMTP(465→587 폴백).
let sendOne;
if (USE_GMAIL_API) {
  console.log('✉ 발송 방식: Gmail API (서비스계정 위임) →', user);
  sendOne = msg => gmailSend(msg);
} else {
  const { default: nodemailer } = await import('nodemailer');
  // family:4 → IPv6 미지원 환경 회피. 465(SMTPS)→587(STARTTLS) 순으로 연결 검증.
  const mkTransport = cfg => nodemailer.createTransport({
    host: 'smtp.gmail.com', family: 4,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
    auth: { user, pass }, ...cfg,
  });
  let tp = null;
  for (const cfg of [{ port: 465, secure: true }, { port: 587, secure: false, requireTLS: true }]) {
    try { const t = mkTransport(cfg); await t.verify(); tp = t; console.log(`✓ SMTP 연결 성공 (포트 ${cfg.port})`); break; }
    catch (e) { console.error(`✗ SMTP 포트 ${cfg.port} 실패: ${e.message}`); }
  }
  if (!tp) { console.error('✗ 모든 SMTP 포트(465/587) 연결 실패 — 아웃바운드 SMTP 차단. Gmail API(GMAIL_SENDER) 사용 권장.'); process.exit(1); }
  sendOne = msg => tp.sendMail(msg);
}

let sent = 0, failed = 0;
for (const j of jobs) {
  const r = await buildReport(j.lang);
  try {
    // 받는사람=발신주소(자기 자신), 실제 수신자는 전부 숨은참조(BCC) → 수령자끼리 목록 비노출
    await sendOne({ from: `${FROM_NAME[j.lang]} <${user}>`, to: `${FROM_NAME[j.lang]} <${user}>`, bcc: j.to, subject: r.subject, html: r.html, attachments: r.attachments });
    console.log(`✉ [${j.lang}] 발송 완료 → BCC: ${j.to}\n   (${r.subject})`); sent++;
  } catch (e) {
    console.error(`✗ [${j.lang}] 발송 실패: ${e.message}`); failed++;
  }
}
console.log(`발송 결과: 성공 ${sent} · 실패 ${failed}`);
if (sent === 0 && failed > 0) process.exit(1);

# game-ops — 부족또전쟁 운영 대시보드 파이프라인

모바일 게임 **부족또전쟁:무한루프RPG** 의 스토어 지표·리뷰를 수집해 일간/주간 운영 대시보드를 생성한다.

## 파이프라인
```
node run.mjs   # = collect → classify(선택) → build
```
- `collect.mjs` — 구글/애플(순위·리뷰·평점, google-play-scraper/app-store-scraper), 원스토어(평점·다운로드 HTML 파싱), 갤럭시(평점·평가수 JSON API + 전체게임 인기순위 chartProductList2Notc), **네이버 라운지**(공개 커뮤니티 API). 원스토어 인기/매출·갤럭시 매출 순위 + **라운지 방문자수**는 구글시트(`config.ranksSheetCsvUrl`, 공개 CSV)에서 읽음. → `data.json` 누적
- `classify.mjs` — 신규 리뷰 감성·주제 분류 + **라운지 여론 요약**(Anthropic API, `ANTHROPIC_API_KEY` 있을 때만). 없으면 스킵(리뷰는 별점 기반, 라운지는 게시판 분포로 표시; 로컬 Claude 세션이 직접 채울 수도 있음)
- `build-dashboard.mjs` — `data.json` → `dashboard.html` (일간/주간·한/중, 실데이터 임베드)
- `lounge-weekly.mjs` — (읽기전용) `node lounge-weekly.mjs [기준일]` 최근 7일 라운지 동향(누적 게시물 증가·일평균 신규글·방문자 추세·여론요약) 출력. 주간보고서 작성 보조용.

### 네이버 라운지 (공개 API, 인증 불필요)
- 베이스 `https://comm-api.game.naver.com/nng_main/v1`, 헤더 `Referer: https://game.naver.com/`. 슬러그(`config`의 `lounge`, 예: `Heart_of_Valor`)가 곧 loungeId.
- 수집: 게시판 구조(`/lounge/{s}/board`, 그룹 포함), 최근글+누적수(`/lounge/{s}/recentCommunity/feeds?limit=30`), **게시판별 글**(`/lounge/{s}/new/popularFeeds/board?boardId={id}` → recentFeeds/popularFeeds), **이벤트 상세**(`/community/lounge/{s}/feed/{feedId}` → 기간 텍스트). 대시보드: 누적 게시물·당일 신규 KPI + **진행 이벤트**(기간·내용·원문링크) + 추이 차트 + AI 여론요약 + **게시판(메뉴)별 탭**(기간 내 새 글 있는 게시판만, 글 최대 5개) → 탭 클릭 시 그 게시판 AI 요약 + 글 목록.
- 스토어 현황 카드의 로고는 **각 스토어에 노출 중인 실제 앱 아이콘**(collect가 data URI로 임베드 — 아티팩트 CSP 대응).

## 배포
`dashboard.html` 을 Claude 아티팩트로 게시(같은 URL 유지).

## 설정
`config.json` — 대상 앱 ID(구글/애플/원스토어/갤럭시), 국가, 구글시트 순위 CSV URL.

## 자동화 (클라우드 루틴)
매일 11:00 KST(02:00 UTC): 리포 클론 → `npm install` → `node run.mjs` → 대시보드 게시 → `data.json`/`dashboard.html` 커밋·푸시. 월요일엔 주간 요약 추가.

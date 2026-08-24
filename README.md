# game-ops — 부족또전쟁 운영 대시보드 파이프라인

모바일 게임 **부족또전쟁:무한루프RPG** 의 스토어 지표·리뷰를 수집해 일간/주간 운영 대시보드를 생성한다.

## 파이프라인
```
node run.mjs   # = collect → classify(선택) → build
```
- `collect.mjs` — 구글/애플(순위·리뷰·평점, google-play-scraper/app-store-scraper), 원스토어(평점·다운로드 HTML 파싱), 갤럭시(평점·평가수 JSON API + 전체게임 인기순위 chartProductList2Notc). 원스토어 인기/매출·갤럭시 매출 순위는 구글시트(`config.ranksSheetCsvUrl`, 공개 CSV)에서 읽음. → `data.json` 누적
- `classify.mjs` — 신규 리뷰 감성·주제 분류(Anthropic API, `ANTHROPIC_API_KEY` 있을 때만). 없으면 스킵(대시보드는 별점 기반 감성 표시)
- `build-dashboard.mjs` — `data.json` → `dashboard.html` (일간/주간·한/중, 실데이터 임베드)

## 배포
`dashboard.html` 을 Claude 아티팩트로 게시(같은 URL 유지).

## 설정
`config.json` — 대상 앱 ID(구글/애플/원스토어/갤럭시), 국가, 구글시트 순위 CSV URL.

## 자동화 (클라우드 루틴)
매일 11:00 KST(02:00 UTC): 리포 클론 → `npm install` → `node run.mjs` → 대시보드 게시 → `data.json`/`dashboard.html` 커밋·푸시. 월요일엔 주간 요약 추가.

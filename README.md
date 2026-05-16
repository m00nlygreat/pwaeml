# 퐤믈

**pwaeml**은 브라우저에서 `.eml` 메일 파일을 열어보고, 첨부파일을 따로 내려받거나 첨부가 제거된 `.eml`을 다시 저장할 수 있는 오프라인 우선 PWA입니다.

## 기능

- `.eml` 파일 로컬 열기
- 메일 헤더, 본문, 첨부파일 확인
- 첨부파일 개별 다운로드
- 모든 첨부파일 ZIP 다운로드
- 첨부파일이 제거된 `.eml` 다운로드
- GitHub Pages 배포용 정적 빌드

## 개발

```bash
npm install
npm run dev
```

## 배포

```bash
npm run build
```

빌드 결과는 `docs/`에 생성되며 GitHub Pages의 `main` 브랜치 `/docs`에서 배포합니다.

# SEASTAR 360 Viewer — 디자인 개선용 순수 소스

> 클로드 디자인에게: 이 폴더가 SEASTAR 360° 도면/파노라마 뷰어의 **UI 소스 전부**입니다.
> 서버·이미지·테스트는 제외했습니다. HTML 구조 + CSS + UI 렌더 JS만.

## 파일
| 파일 | 역할 |
|------|------|
| `index.html` | 전체 화면 구조 — 모든 screen/모달/툴바/사이드바/파노뷰어 |
| `css/style.css` (210KB) | **메인 스타일 전부**. `:root`에 디자인 토큰(색·간격·타이포 CSS 변수) |
| `css/seastar-family-tokens.css` | SEcMS 패밀리룩 추가분(style.css **뒤에 로드 → override**). 골드 버튼·고밀도 리스트·.fl-* 헬퍼 |
| `js/main.js` (508KB, 비minify) | UI 동적 렌더 — 핀 마커(SVG)·프로젝트 카드·파노 뷰어·관리자 패널 등 |
| `js/firebase-config.js` | Firebase 설정(디자인 무관) |

## 디자인 토큰 (style.css `:root`)
- 브랜드: 아이보리 `--bg/--cream`, 골드 `--gold`(#c9962a), 네이비 보조, Pretendard 폰트
- 패밀리 기준: SEcMS(secms.tech) = SAP Fiori 풍 샤프(2px)·고밀도·골드 액센트

## 주요 디자인 영역 (어디를 고치면 되나)
| 영역 | HTML(index.html) | CSS(style.css 클래스) | 동적 JS(main.js) |
|------|------------------|----------------------|------------------|
| 홈/프로젝트 허브 | `#screen-projects` | `.hub-card`·`.hub-card-thumb`·`.hub-btn-new` | `ProjectHub.render` (카드·호선 SVG) |
| 상단 인증바 | `.hub-authbar` | `.btn-demo`·`.auth-*` | `Auth._applyUi` |
| 작업 툴바 | `#topbar` | `.tb-btn`·`.tb-*` | — |
| 사이드바(구역/핀/배포) | `#sidebar` | `.sidebar-section`·`.btn-place`·`.checkboard-*` | — |
| 핀 마커 | (동적) | `.pin-marker`·`.pin-pin` | `UI.renderPinsOnMap` (SVG viewBox 0 0 36 64) |
| 360 파노 뷰어 | `#screen-pano` | `.pano-header`·`.pano-location`·`.pano-radar`(미니맵)·파노 컨트롤 | `PanoViewer` |
| 관리자 패널 | `#designers-modal` | `.designer-row`·`.adm-*`·`.member-row` | `Designers`·`AdminPanels` |
| 버튼 전반 | — | `.btn-demo-designer`·`.hub-btn-new`(골드 그라데이션) | — |

## 보는 법
- `index.html`을 그대로 열면 UI가 렌더됩니다(API는 서버 필요하나 디자인 검토엔 무관).
- 색/간격/모양은 **거의 전부 CSS**에서 조정 가능. 핀 마커·카드 SVG만 main.js 안에 인라인.

## 개선 가이드(마스터 의도)
- 패밀리룩 = **SEcMS처럼**: 샤프 2px, 골드 그라데이션 버튼, 고밀도 리스트, 상단 리본 느낌, 대문자 헤더.
- 현재 ~30% 수준 → 메뉴/상단/리스트/전체 레이아웃 비주얼 강화 필요.
- 개선 후 `style.css`·`seastar-family-tokens.css`·`index.html` 교체본을 돌려주시면 빌드·배포합니다.

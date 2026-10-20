# CLAUDE.md - KICE 수능 출제 지침 기반 문항 분류·평가 시스템

## 1. 프로젝트 개요 (Overview)
- **목적**: 수능/모의평가/학력평가 시험지(PDF, HWP, HWPX, 이미지)를 한국교육과정평가원(KICE) 이원목적분류표(내용영역 × 행동영역) 체계로 자동 분류하고 시험 전체 난이도 총평 및 주요 변별 문항을 평가·분석하는 풀스택 웹 애플리케이션.
- **공개 배포 URL**: `https://kice-item-classifier.onrender.com`
- **소유자 관리자 URL**: `https://kice-item-classifier.onrender.com/?admin=1`
- **로컬 실행 URL**: `http://localhost:8080`
- **GitHub 저장소**: `https://github.com/Codingbaby-shark/kice-item-classifier` (Public)

---

## 2. 기술 스택 및 아키텍처 (Tech Stack & Architecture)
- **백엔드**: Python 3.11 (외부 프레임워크 종속성 없는 내장 `http.server.SimpleHTTPRequestHandler` 기반 멀티스레드 서버)
- **프론트엔드**: Vanilla JS (ES6+) + CSS3 + HTML5 SPA (빌드 단계/Node.js/npm 불필요)
- **렌더링 라이브러리**: CDN 기반 KaTeX (수식 렌더링), SheetJS (xlsx 내보내기)
- **클라우드 호스팅**: Render Free Tier (Docker 기반 컨테이너 자동 배포)
- **주요 데이터 포맷**: JSON 기반 평가틀(`data/kice_frameworks.json`), JSONL 기반 사용 로그(`data/usage_logs.jsonl`)

---

## 3. 핵심 디렉토리 및 파일 구조 (Directory Structure)

```
.
├── server.py              # 메인 백엔드 서버 (REST API 라우팅, 정적 파일 서빙, 텔레메트리)
├── app.py                 # WSGI 애플리케이션 어댑터
├── analyzer.py            # AI 엔진 연동 코어 (Gemini, Codex CLI, Claude CLI, OpenAI, Anthropic)
├── parsers.py             # 시험지 파서 (PDF 텍스트/수식 추출, HWP/HWPX 파싱, 짝수형 중복 제거)
├── Dockerfile             # Render 배포용 가벼운 Docker 이미지 (python:3.11-slim)
├── requirements.txt       # 의존 패키지 정의
├── .env                   # [보안 중요] 로컬 API 키 보관 (Git 추적 금지)
├── data/
│   ├── kice_frameworks.json # 2015/2022 개정 국어·수학·사탐·과탐 평가틀 DB
│   ├── sample_exams.json    # 데모용 샘플 기출문항 데이터
│   ├── history.json         # 분석 리포트 보관함 (최근 30건)
│   ├── logging_config.json  # 소유자 구글 시트 웹훅 설정
│   └── usage_logs.jsonl     # 서버 백업용 사용 기록 로그
└── static/
    ├── index.html         # 단일 페이지 애플리케이션 (5개 탭 + 관리자 모달)
    ├── app.js             # 프론트엔드 비즈니스 로직, 상태 관리, 이벤트 처리
    └── style.css          # KICE 스타일 디자인 시스템, 반응형, 인쇄 스타일
```

---

## 4. 핵심 AI 엔진 및 분석 파이프라인 (`analyzer.py`)

1. **Google Gemini API (기본 클라우드 엔진)**:
   - 클라우드 환경변수 `GEMINI_API_KEY` 탑재로 일반 사용자에게 무료 1-클릭 분석 제공.
   - 기본 모델: `gemini-3.5-flash` (구글 신규 정책 부합).
   - 자동 복구(Fallback) 체계: 404/503 발생 시 `gemini-flash-latest` -> `gemini-3.8-flash` 순서로 즉시 자동 우회 재시도.
2. **로컬 구독 세션 연동 (PC 환경 감지)**:
   - `codex`: 로컬 설치된 `codex exec` CLI 및 `~/.codex/auth.json` 토큰 활용.
   - `claude`: 로컬 설치된 `claude -p` CLI 및 `~/.claude` 토큰 활용.
3. **OpenAI / Anthropic 직접 API 연동**:
   - `gpt-4o`, `claude-sonnet-4-20250514` 모델 직접 호출 지원.
4. **웹 브라우저 복붙 모드 (`web_bridge`)**:
   - API 키가 없는 사용자를 위해 시스템 프롬프트 전체 복사 -> 웹 AI 붙여넣기 -> JSON 결과 수신 파이프라인 내장.

---

## 5. 시험지 파서 및 특수 처리 (`parsers.py`)
- **한글 수식 PUA 유니코드 디코딩 (`decode_kice_pua_text`)**:
  - HWP/PDF에서 추출된 수능 기출 특유의 한글 전용 PUA(Private Use Area) 수식 기호(루트, 적분, 원문자 `①~⑮` 등)를 표준 UTF-8 및 LaTeX 기호로 자동 복원.
- **짝수형 페이지 자동 필터링**:
  - 평가원 수능 PDF에 홀수형/짝수형이 함께 들어있는 경우, 중복되는 짝수형 페이지를 감지하여 토큰 소모를 ~50% 이상 절감.
- **HWP / HWPX 파싱**:
  - `olefile` 및 `zipfile`을 통해 HWP 5.0 레코드 스트림 및 HWPX XML 문서를 직접 파싱.

---

## 6. 교육과정 및 이원목적분류 체계 (`data/kice_frameworks.json`)
- **2015 개정 교육과정 (현 고3·N수생 대상)**:
  - 수학: 공통(수I, 수II) + 선택(확률과 통계, 미적분, 기하)
  - 국어: 공통(독서, 문학) + 선택(화법과 작문, 언어와 매체)
  - 탐구: 사탐 9과목, 과탐 8과목
- **2022 개정 교육과정 (고1·고2 대상)**:
  - 수학: 공통수학 1·2 (행렬 복원), 대수, 미적분 I, 확률과 통계
  - 국어: 공통국어 1·2, 통합수능 체제
  - 탐구: 통합사회 1·2, 통합과학 1·2
- **분류 원칙**:
  - **단일 행동영역**: KICE 기준에 따라 각 문항당 핵심 단일 행동영역 1개(계산, 이해, 추론, 문제해결)만 엄격 배정.
  - **난이도 총평**: 개별 문항 상/중/하 등급을 나열하지 않고, **시험 전체 체감 난이도 총평** 및 **주요 변별·고난도 킬러/준킬러 문항 심층 분석** 산출.

---

## 7. 구글 시트 비공개 로깅 시스템 (Admin Telemetry)
- **일반 사용자 관점**: 100% 무표시 (로그 기능 UI 없음, 성능 지연 0ms의 비동기 백그라운드 전송).
- **소유자 전용 접근**: URL 끝에 `?admin=1` 파라미터 부여 시 우측 하단에 관리자 플로팅 버튼 활성화.
- **구글 시트 연동**: Apps Script Webhook URL (`https://script.google.com/macros/s/.../exec`) 등록 시 모든 사용자의 문항 분석, 파일 업로드, 리포트 출력 기록이 구글 시트에 1행씩 실시간 누적.

---

## 8. 로컬 개발 및 유지보수 명령어 (Commands)

```bash
# 로컬 개발 서버 실행 (포트 8080)
python3 server.py 8080

# 의존 패키지 설치
pip install -r requirements.txt

# Render 클라우드 배포 (main 브랜치 푸시 시 자동 배포)
git add .
git commit -m "Your commit message"
git push origin main
```

---

## 9. 유지보수 시 절대 주의사항 (Critical Rules)
1. **API Key 보안**: GitHub 저장소가 Public 상태입니다. 어떠한 경우에도 소스 코드에 API 키를 하드코딩하거나 git commit하지 마십시오. (항상 `.env` 또는 Render Environment Variables 사용)
2. **단일 행동영역 원칙 유지**: KICE 공식 이원목적분류 지침에 따라 문항별 행동영역은 1개만 매핑되어야 합니다.
3. **가벼운 배포 환경 유지**: Render Free Tier 메모리는 512MB입니다. 무거운 머신러닝 라이브러리(Torch, Transformers 등)나 Node.js 런타임을 추가하지 말고 순수 Python 경량 구조를 유지하십시오.

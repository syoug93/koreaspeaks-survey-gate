# 국민대화 본인인증 설문 앱

실제로 실행 가능한 본인인증 설문 게이트 앱입니다. 기본안은 `본인인증 게이트 → 구글 설문지 이동`입니다. 포트원 본인인증 계약에서 발급받은 `storeId`, `channelKey`, `API_SECRET`을 넣으면 휴대폰 본인인증 창이 열립니다.

## 실행

실제 본인인증 실행:

```bash
AUTH_MODE=REAL \
PORTONE_STORE_ID=store-... \
PORTONE_CHANNEL_KEY=channel-key-... \
PORTONE_API_SECRET=... \
PUBLIC_BASE_URL=https://배포도메인.example \
node server.js
```

이 환경에서 Node가 기본 PATH에 없으면 `node server.js` 대신 아래 Node 경로를 사용합니다.

```bash
/Users/syoug93/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server.js
```

브라우저에서 `http://localhost:3000`을 열면 됩니다.

## MOCK 테스트 방법

포트원 계약값이 아직 없을 때만 MOCK을 켭니다.

```bash
AUTH_MODE=MOCK ALLOW_MOCK=1 node server.js
```

1. 생년월일 `2000-01-01`, 휴대폰 번호 `01012345678`로 본인인증을 진행합니다.
2. 설문 영역이 열리면 이름, 연락처, 개인정보 동의와 필수 문항을 입력하고 제출합니다.
3. 같은 생년월일과 같은 번호로 다시 인증하면 중복 차단됩니다.
4. `2007-01-01`처럼 대상 연령 밖의 생년월일을 넣으면 탈락합니다.
5. 제출 응답은 `/admin/responses`에서 JSON으로 확인합니다.

서버를 재시작하면 메모리의 중복 기록과 응답 기록은 초기화됩니다.

## REAL 모드

포트원 본인인증 채널이 준비되면 아래 환경변수를 설정합니다. `PUBLIC_BASE_URL`은 모바일 리다이렉트 방식 본인인증이 돌아올 HTTPS 주소입니다.

```bash
AUTH_MODE=REAL \
PORTONE_STORE_ID=store-... \
PORTONE_CHANNEL_KEY=channel-key-... \
PORTONE_API_SECRET=... \
PUBLIC_BASE_URL=https://배포도메인.example \
node server.js
```

REAL 모드는 브라우저에서 포트원 V2 SDK를 로드하고 `PortOne.requestIdentityVerification()`을 호출합니다. 인증 완료 후 서버가 `https://api.portone.io/identity-verifications/{identityVerificationId}`를 재조회해 `birthDate`, `ci` 또는 `di`를 확인합니다. 서버 재조회 결과가 `VERIFIED`가 아니면 설문으로 넘어가지 않습니다.

포트원 관리자 콘솔에서 필요한 값:

- Store ID
- 본인인증 채널 키
- API Secret
- 본인인증 PG 채널: 다날 휴대폰 본인인증, KCP 휴대폰 본인인증, KG이니시스 통합인증 중 택일

## 외부 설문 플랫폼으로 연결

현재 기본 외부 설문 URL은 제공받은 구글폼 응답 링크입니다.

- 편집 링크: https://docs.google.com/forms/d/1P0m6k7oTFoMrfPY-VAWlsgHWeAYp2UmmjyRNiVsPcLU/edit
- 응답 링크: https://docs.google.com/forms/d/e/1FAIpQLSdHDa0iHyUTuMbnaFCshHEyLupmmSTVs1563bfB4nxG6ij1xg/viewform?usp=dialog

같은 서버에서 두 안을 모두 볼 수 있습니다.

- 심사용 단일 페이지: `http://localhost:3000/service`
- 기본안 구글폼 연결: `http://localhost:3000/?survey=external`
- 대체안 자체 설문 후 구글폼 백업: `http://localhost:3000/?survey=hybrid`
- 예비안 자체 설문만: `http://localhost:3000/?survey=internal`
- 개인정보 처리방침: `http://localhost:3000/privacy`
- 이용 안내: `http://localhost:3000/terms`
- 환불 정책: `http://localhost:3000/refund`

다른 구글폼, 타입폼, 서베이몽키 등으로 바꾸려면 `EXTERNAL_SURVEY_URL`을 설정합니다.

```bash
SURVEY_MODE=EXTERNAL \
EXTERNAL_SURVEY_URL="https://forms.gle/..." \
node server.js
```

기본안은 본인인증을 통과한 사람에게만 구글 설문지 입장 링크를 열어줍니다. 다만 구글폼은 서버 토큰 검증을 강제할 수 없으므로, 최종 제출 단계의 1인 1응답을 법적으로 강하게 보장해야 한다면 예비안인 `SURVEY_MODE=INTERNAL` 자체 설문 방식으로 전환합니다. 중간 선택지로 `SURVEY_MODE=HYBRID`를 사용하면 본인인증 후 자체 설문을 먼저 받고, 제출 오류 시 구글폼으로 대체 이동할 수 있습니다.

## 자체 설문 문항

자체 설문 문항은 `survey-schema.json`에 정의되어 있습니다. 문항을 추가하거나 수정할 때는 이 파일의 `sections[].questions[]`를 고치면 화면 렌더링, 서버 필수값 검증, JSON/CSV 아카이브가 함께 반영됩니다.

지원 문항 유형:

- `text`: 단답형
- `textarea`: 장문형
- `radio`: 단일 선택
- `checkbox`: 복수 선택

현재 자체 설문에는 이름, 연락처, 개인정보 수집 및 이용 동의 항목이 포함되어 있습니다.

## 자체 설문 응답 아카이브

자체 설문 또는 하이브리드 자체 설문 응답은 기본적으로 `data/responses.jsonl`에 한 줄 JSON으로 저장됩니다.

확인 URL:

- JSON: `http://localhost:3000/admin/responses`
- CSV: `http://localhost:3000/admin/responses.csv`

관리자 응답 확인 URL은 `ADMIN_PASSWORD` 환경변수를 설정해야 열립니다. 브라우저 인증창에서 사용자명은 아무 값이나 입력하고, 비밀번호에는 `ADMIN_PASSWORD` 값을 입력합니다.

운영 권장안은 Render Postgres입니다. `DATABASE_URL` 환경변수를 설정하면 앱이 Postgres에 `survey_responses` 테이블을 자동 생성하고 응답을 저장합니다. 다문항 응답은 `answers` JSONB 컬럼에 저장되며 CSV 다운로드 시 문항 ID별 컬럼으로 펼쳐집니다. `DATABASE_URL`이 없거나 DB 연결이 실패하면 `data/responses.jsonl` 파일 저장으로 fallback합니다.

## 설정

- `PORT`: 기본 `3000`
- `AUTH_MODE`: `MOCK` 또는 `REAL`
- `ALLOW_MOCK`: `1`일 때만 MOCK 인증 허용
- `SURVEY_MODE`: `EXTERNAL`, `HYBRID`, 또는 `INTERNAL`
- `EXTERNAL_SURVEY_URL`: 외부 설문 URL
- `MIN_AGE`: 기본 `20`
- `MAX_AGE`: 기본 `39`
- `PORTONE_STORE_ID`: REAL 모드에서 필요
- `PORTONE_CHANNEL_KEY`: REAL 모드에서 필요
- `PORTONE_API_SECRET`: REAL 모드에서 필요
- `PUBLIC_BASE_URL`: 모바일 리다이렉트 인증에 사용할 HTTPS 배포 주소
- `SERVICE_NAME`: 서비스명
- `OPERATOR_NAME`: 운영 주체명
- `OPERATOR_CONTACT`: 문의 연락처
- `BUSINESS_INFO`: 사업자등록번호, 대표자, 주소 등 심사용 사업자 정보
- `RESPONSES_FILE`: 자체 설문 응답 JSONL 저장 경로
- `DATABASE_URL`: Render Postgres 또는 외부 Postgres 접속 URL
- `ADMIN_PASSWORD`: `/admin/responses`, `/admin/responses.csv` 접근 비밀번호

## 운영 전 교체해야 할 부분

- 메모리 저장소를 Redis/RDB로 교체
- 일회성 토큰을 서명된 JWT 또는 DB 기반 토큰으로 교체
- HTTPS 배포
- 개인정보 처리방침과 동의 문안 확정
- 원본 CI/DI 미저장 원칙 유지

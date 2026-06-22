# Render 임시 배포 절차

이 앱은 Render Web Service로 바로 배포할 수 있게 준비되어 있습니다.

## 1. GitHub 저장소 만들기

GitHub에서 새 저장소를 만듭니다.

예시 저장소명:

```text
koreaspeaks-survey-gate
```

이 폴더의 파일 전체를 저장소 루트에 올립니다.

필수 파일:

- `server.js`
- `survey-schema.json`
- `package.json`
- `render.yaml`
- `README.md`

## 2. Render에서 Blueprint 배포

1. https://dashboard.render.com 접속
2. New → Blueprint 선택
3. GitHub 저장소 `koreaspeaks-survey-gate` 연결
4. Render가 `render.yaml`을 읽어 `koreaspeaks-survey-gate` Web Service를 생성
5. 최초 배포 완료 후 Render 서비스 URL 확인

예상 URL 형식:

```text
https://koreaspeaks-survey-gate.onrender.com
```

## 3. Render 환경변수 설정

Render 서비스의 Environment 탭에서 아래 값을 설정합니다.

```text
AUTH_MODE=REAL
SURVEY_MODE=HYBRID
MIN_AGE=20
MAX_AGE=39
EXTERNAL_SURVEY_URL=https://docs.google.com/forms/d/e/1FAIpQLSdHDa0iHyUTuMbnaFCshHEyLupmmSTVs1563bfB4nxG6ij1xg/viewform?usp=dialog
PUBLIC_BASE_URL=https://koreaspeaks-survey-gate.onrender.com
PORTONE_STORE_ID=포트원에서_발급받은_store_id
PORTONE_CHANNEL_KEY=포트원에서_발급받은_channel_key
PORTONE_API_SECRET=포트원에서_발급받은_api_secret
DATABASE_URL=Render_Postgres_Internal_Database_URL
```

포트원 키가 아직 없으면 `PORTONE_*` 값은 비워둘 수 있지만, 실제 본인인증은 시작되지 않습니다.

## 3-1. Render Postgres 설정

하이브리드 또는 자체 설문 응답을 안정적으로 저장하려면 Render Postgres를 추가합니다.

1. Render Dashboard → New → Postgres 선택
2. 이름 예시: `koreaspeaks-survey-db`
3. 같은 Region에 생성
4. 생성 후 Postgres 상세 화면에서 `Internal Database URL` 복사
5. Web Service `koreaspeaks-survey-gate` → Environment에 아래 값 추가

```text
DATABASE_URL=복사한_Internal_Database_URL
```

앱은 시작 시 `survey_responses` 테이블을 자동 생성합니다. 저장 확인:

```text
https://koreaspeaks-survey-gate.onrender.com/admin/responses
https://koreaspeaks-survey-gate.onrender.com/admin/responses.csv
```

## 4. 포트원 신청/설정에 넣을 URL

서비스 URL:

```text
https://koreaspeaks-survey-gate.onrender.com/service
```

심사 항목은 아래 단일 URL에서 모두 확인할 수 있게 구성되어 있습니다.

```text
https://koreaspeaks-survey-gate.onrender.com/service
```

이 페이지 안에 웹사이트 접속 가능 여부, 사업자 정보, 이용약관, 개인정보처리방침, 환불 정책, 상품/서비스 정보가 모두 노출됩니다.

본인인증 완료/리다이렉트 URL:

```text
https://koreaspeaks-survey-gate.onrender.com/identity-verification-redirect
```

권장 운영안은 `SURVEY_MODE=HYBRID`입니다. 본인인증 후 자체 설문 응답을 DB에 저장하고, 제출 오류가 있을 때만 구글폼으로 대체 이동할 수 있습니다. 구글폼만 사용할 경우 `SURVEY_MODE=EXTERNAL`, 자체 설문만 사용할 경우 `SURVEY_MODE=INTERNAL`로 바꿉니다.

## 5. 배포 후 확인

설정 상태:

```text
https://koreaspeaks-survey-gate.onrender.com/api/config
```

기본안 구글폼 연결 흐름:

```text
https://koreaspeaks-survey-gate.onrender.com/?survey=external
```

대체안 자체 설문 후 구글폼 백업 흐름:

```text
https://koreaspeaks-survey-gate.onrender.com/?survey=hybrid
```

심사용 서비스 소개:

```text
https://koreaspeaks-survey-gate.onrender.com/service
```

예비안 자체 설문 흐름:

```text
https://koreaspeaks-survey-gate.onrender.com/?survey=internal
```

자체 설문 응답 아카이브:

```text
https://koreaspeaks-survey-gate.onrender.com/admin/responses
https://koreaspeaks-survey-gate.onrender.com/admin/responses.csv
```

자체 설문 문항 수정 파일:

```text
survey-schema.json
```

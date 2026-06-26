"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const ALLOW_MOCK = process.env.ALLOW_MOCK === "1";
const AUTH_MODE = (process.env.AUTH_MODE || "REAL").toUpperCase();
const PORTONE_API_SECRET = process.env.PORTONE_API_SECRET || "";
const PORTONE_STORE_ID = process.env.PORTONE_STORE_ID || "";
const PORTONE_CHANNEL_KEY = process.env.PORTONE_CHANNEL_KEY || "";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
const MIN_AGE = Number(process.env.MIN_AGE || 19);
const MAX_AGE = Number(process.env.MAX_AGE || 39);
const SURVEY_MODE = (process.env.SURVEY_MODE || "EXTERNAL").toUpperCase();
const DEFAULT_GOOGLE_FORM_URL = "https://docs.google.com/forms/d/e/1FAIpQLSdHDa0iHyUTuMbnaFCshHEyLupmmSTVs1563bfB4nxG6ij1xg/viewform?usp=dialog";
const GOOGLE_FORM_EDIT_URL = "https://docs.google.com/forms/d/1P0m6k7oTFoMrfPY-VAWlsgHWeAYp2UmmjyRNiVsPcLU/edit";
const EXTERNAL_SURVEY_URL = process.env.EXTERNAL_SURVEY_URL || DEFAULT_GOOGLE_FORM_URL;
const SERVICE_NAME = process.env.SERVICE_NAME || "현장형 국민대화 신청접수 및 설문";
const OPERATOR_NAME = process.env.OPERATOR_NAME || "코리아스픽스(주)";
const OPERATOR_CONTACT = process.env.OPERATOR_CONTACT || "02-3280-0564";
const BUSINESS_INFO = process.env.BUSINESS_INFO || "사업자등록번호 107-87-82338 / 대표자 이병덕 / 주소 서울특별시 마포구 양화로 81, 408호";
const RESPONSES_FILE = process.env.RESPONSES_FILE || path.join(__dirname, "data", "responses.jsonl");
const DATABASE_URL = process.env.DATABASE_URL || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SURVEY_SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, "survey-schema.json"), "utf8"));

const usedPersonHashes = new Set();
const gateTokens = new Map();
const surveyResponses = [];
let pgPoolPromise;

function getPortOneConfigStatus() {
  const missing = [];
  if (!PORTONE_STORE_ID) missing.push("PORTONE_STORE_ID");
  if (!PORTONE_CHANNEL_KEY) missing.push("PORTONE_CHANNEL_KEY");
  if (!PORTONE_API_SECRET) missing.push("PORTONE_API_SECRET");
  return {
    ready: missing.length === 0,
    missing
  };
}

function calcKoreanAge(birthDate, now = new Date()) {
  const birth = typeof birthDate === "string" ? new Date(`${birthDate}T00:00:00+09:00`) : birthDate;
  if (!(birth instanceof Date) || Number.isNaN(birth.getTime())) {
    throw new Error("Invalid birthDate");
  }

  let age = now.getFullYear() - birth.getFullYear();
  const birthdayThisYear = new Date(now.getFullYear(), birth.getMonth(), birth.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (today < birthdayThisYear) age -= 1;
  return age;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function issueGateToken(profile) {
  const token = crypto.randomBytes(32).toString("hex");
  gateTokens.set(token, {
    createdAt: Date.now(),
    used: false,
    profile
  });
  return token;
}

function appendGateToken(url, token) {
  const parsed = new URL(url);
  parsed.searchParams.set("gateToken", token);
  return parsed.toString();
}

function appendSurveyArchive(record) {
  fs.mkdirSync(path.dirname(RESPONSES_FILE), { recursive: true });
  fs.appendFileSync(RESPONSES_FILE, `${JSON.stringify(record)}\n`, "utf8");
}

function readSurveyArchive() {
  if (!fs.existsSync(RESPONSES_FILE)) return [];
  return fs.readFileSync(RESPONSES_FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getSurveyQuestions() {
  return SURVEY_SCHEMA.sections.flatMap((section) => section.questions.map((question) => ({
    ...question,
    sectionId: section.id,
    sectionTitle: section.title
  })));
}

function getQuestionById(questionId) {
  return getSurveyQuestions().find((question) => question.id === questionId);
}

function normalizeAnswer(question, value) {
  if (question.type === "checkbox") {
    if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
    if (value === undefined || value === null || value === false) return [];
    return [String(value).trim()].filter(Boolean);
  }
  return String(value ?? "").trim();
}

function validateSurveyAnswers(answers) {
  const normalized = {};
  for (const question of getSurveyQuestions()) {
    const value = normalizeAnswer(question, answers[question.id]);
    normalized[question.id] = value;
    if (question.required) {
      const hasValue = Array.isArray(value) ? value.length > 0 : Boolean(value);
      if (!hasValue) {
        return {
          ok: false,
          message: `필수 문항을 입력해 주세요: ${question.label}`
        };
      }
    }
  }

  const consent = normalized.privacy_collection_agree || [];
  if (!Array.isArray(consent) || !consent.includes("동의합니다")) {
    return { ok: false, message: "개인정보 수집 및 이용 동의가 필요합니다." };
  }

  return { ok: true, answers: normalized };
}

async function getPgPool() {
  if (!DATABASE_URL) return null;
  if (!pgPoolPromise) {
    pgPoolPromise = (async () => {
      const { Pool } = require("pg");
      const pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
      });
      await pool.query(`
        CREATE TABLE IF NOT EXISTS survey_responses (
          id BIGSERIAL PRIMARY KEY,
          submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          age INTEGER,
          gender TEXT,
          respondent_name TEXT,
          respondent_phone TEXT,
          privacy_consent BOOLEAN NOT NULL DEFAULT FALSE,
          answers JSONB NOT NULL DEFAULT '{}'::jsonb,
          region TEXT,
          topic TEXT,
          opinion TEXT,
          join_roundtable BOOLEAN NOT NULL DEFAULT FALSE
        )
      `);
      await pool.query(`ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS respondent_name TEXT`);
      await pool.query(`ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS respondent_phone TEXT`);
      await pool.query(`ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS privacy_consent BOOLEAN NOT NULL DEFAULT FALSE`);
      await pool.query(`ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS answers JSONB NOT NULL DEFAULT '{}'::jsonb`);
      await pool.query(`ALTER TABLE survey_responses ALTER COLUMN region DROP NOT NULL`);
      await pool.query(`ALTER TABLE survey_responses ALTER COLUMN topic DROP NOT NULL`);
      await pool.query(`ALTER TABLE survey_responses ALTER COLUMN opinion DROP NOT NULL`);
      return pool;
    })();
  }
  return pgPoolPromise;
}

async function saveSurveyResponse(record) {
  if (DATABASE_URL) {
    try {
      const pool = await getPgPool();
      const result = await pool.query(
        `INSERT INTO survey_responses
          (submitted_at, age, gender, respondent_name, respondent_phone, privacy_consent, answers, region, topic, opinion, join_roundtable)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
         RETURNING id, submitted_at AS "submittedAt", age, gender,
          respondent_name AS "respondentName",
          respondent_phone AS "respondentPhone",
          privacy_consent AS "privacyConsent",
          answers, region, topic, opinion, join_roundtable AS "joinRoundtable"`,
        [
          record.submittedAt,
          record.age,
          record.gender,
          record.respondentName,
          record.respondentPhone,
          record.privacyConsent,
          JSON.stringify(record.answers || {}),
          record.region || null,
          record.topic || null,
          record.opinion || null,
          record.joinRoundtable || false
        ]
      );
      return result.rows[0];
    } catch (error) {
      console.error("Postgres archive failed; falling back to JSONL", error);
    }
  }

  appendSurveyArchive(record);
  return record;
}

async function readSurveyResponses() {
  if (DATABASE_URL) {
    try {
      const pool = await getPgPool();
      const result = await pool.query(
        `SELECT id, submitted_at AS "submittedAt", age, gender,
          respondent_name AS "respondentName",
          respondent_phone AS "respondentPhone",
          privacy_consent AS "privacyConsent",
          answers, region, topic, opinion, join_roundtable AS "joinRoundtable"
         FROM survey_responses
         ORDER BY id DESC
         LIMIT 1000`
      );
      return result.rows;
    } catch (error) {
      console.error("Postgres read failed; falling back to JSONL", error);
    }
  }

  return readSurveyArchive();
}

function cleanupTokens() {
  const maxAgeMs = 30 * 60 * 1000;
  const now = Date.now();
  for (const [token, entry] of gateTokens.entries()) {
    if (entry.used || now - entry.createdAt > maxAgeMs) {
      gateTokens.delete(token);
    }
  }
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function html(res, body) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function unauthorized(res) {
  res.writeHead(401, {
    "Content-Type": "text/plain; charset=utf-8",
    "WWW-Authenticate": 'Basic realm="Survey Admin"'
  });
  res.end("Authentication required");
}

function isAdminAuthorized(req) {
  if (!ADMIN_PASSWORD) return false;
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const password = decoded.slice(decoded.indexOf(":") + 1);
  const expected = Buffer.from(ADMIN_PASSWORD);
  const actual = Buffer.from(password);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function requireAdmin(req, res) {
  if (isAdminAuthorized(req)) return true;
  unauthorized(res);
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function fetchPortOneIdentityVerification(identityVerificationId) {
  if (!PORTONE_API_SECRET) {
    throw new Error("PORTONE_API_SECRET is required in REAL mode");
  }

  const response = await fetch(`https://api.portone.io/identity-verifications/${encodeURIComponent(identityVerificationId)}`, {
    method: "GET",
    headers: {
      Authorization: `PortOne ${PORTONE_API_SECRET}`,
      "Content-Type": "application/json"
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || `PortOne API failed: ${response.status}`);
  }
  return payload;
}

async function verifyRealIdentity(body) {
  const identityVerificationId = String(body.identityVerificationId || "");
  if (!identityVerificationId) {
    return { ok: false, status: 400, message: "본인인증 ID가 없습니다." };
  }

  const verification = await fetchPortOneIdentityVerification(identityVerificationId);
  if (verification.status !== "VERIFIED") {
    return { ok: false, status: 403, message: "본인인증이 완료되지 않았습니다." };
  }

  const customer = verification.verifiedCustomer || {};
  const birthDate = customer.birthDate;
  const personKey = customer.ci || customer.di;
  if (!birthDate || !personKey) {
    return { ok: false, status: 422, message: "인증기관에서 연령 또는 중복 확인 정보를 받지 못했습니다." };
  }

  return {
    ok: true,
    birthDate,
    gender: customer.gender || "",
    personKey
  };
}

function verifyMockIdentity(body) {
  if (!ALLOW_MOCK) {
    return { ok: false, status: 403, message: "MOCK 인증은 비활성화되어 있습니다. ALLOW_MOCK=1로 실행한 경우에만 사용할 수 있습니다." };
  }

  const birthDate = String(body.birthDate || "");
  const mockPhone = String(body.mockPhone || "").replace(/\D/g, "");
  const gender = String(body.gender || "");

  if (!birthDate || !mockPhone) {
    return { ok: false, status: 400, message: "MOCK 인증에는 생년월일과 휴대폰 번호가 필요합니다." };
  }
  if (!/^\d{10,11}$/.test(mockPhone)) {
    return { ok: false, status: 400, message: "휴대폰 번호 형식을 확인해 주세요." };
  }

  return {
    ok: true,
    birthDate,
    gender,
    personKey: `mock:${birthDate}:${mockPhone}`
  };
}

async function handleVerify(req, res) {
  try {
    cleanupTokens();
    const body = await readBody(req);
    const portOneConfig = getPortOneConfigStatus();
    if (AUTH_MODE === "REAL" && !portOneConfig.ready) {
      return json(res, 503, {
        pass: false,
        message: `포트원 본인인증 설정이 필요합니다: ${portOneConfig.missing.join(", ")}`
      });
    }
    const verified = AUTH_MODE === "REAL" ? await verifyRealIdentity(body) : verifyMockIdentity(body);

    if (!verified.ok) {
      return json(res, verified.status, { pass: false, message: verified.message });
    }

    const age = calcKoreanAge(verified.birthDate);
    if (age < MIN_AGE || age > MAX_AGE) {
      return json(res, 403, {
        pass: false,
        age,
        message: `대상 연령이 아닙니다. 확인된 만 나이: ${age}세`
      });
    }

    const personHash = sha256(verified.personKey);
    if (usedPersonHashes.has(personHash)) {
      return json(res, 409, {
        pass: false,
        age,
        message: "이미 본인인증을 통과한 참여자입니다."
      });
    }

    usedPersonHashes.add(personHash);
    const token = issueGateToken({
      age,
      gender: verified.gender,
      personHash
    });

    return json(res, 200, {
      pass: true,
      age,
      token
    });
  } catch (error) {
    console.error(error);
    return json(res, 500, { pass: false, message: "본인인증 처리 중 오류가 발생했습니다." });
  }
}

async function handleSubmit(req, res) {
  try {
    cleanupTokens();
    const body = await readBody(req);
    const token = String(body.token || "");
    const tokenEntry = gateTokens.get(token);

    if (!tokenEntry || tokenEntry.used) {
      return json(res, 403, { ok: false, message: "유효한 본인인증 토큰이 없습니다. 처음부터 다시 진행해 주세요." });
    }

    const validated = validateSurveyAnswers(body.answers || {});
    if (!validated.ok) {
      return json(res, 400, { ok: false, message: validated.message });
    }

    const record = {
      id: surveyResponses.length + 1,
      submittedAt: new Date().toISOString(),
      age: tokenEntry.profile.age,
      gender: tokenEntry.profile.gender,
      respondentName: String(validated.answers.respondent_name || "").trim(),
      respondentPhone: String(validated.answers.respondent_phone || "").replace(/\D/g, ""),
      privacyConsent: true,
      answers: validated.answers,
      region: validated.answers.SQ3 || "",
      topic: validated.answers.D1 || "",
      opinion: validated.answers.D4 || validated.answers.D5_2 || "",
      joinRoundtable: false
    };

    const savedRecord = await saveSurveyResponse(record);
    tokenEntry.used = true;
    surveyResponses.push(savedRecord);

    return json(res, 200, { ok: true, message: "설문 응답이 제출되었습니다." });
  } catch (error) {
    console.error(error);
    return json(res, 500, { ok: false, message: "설문 제출 중 오류가 발생했습니다." });
  }
}

async function handleResponses(req, res) {
  const archivedResponses = await readSurveyResponses();
  json(res, 200, {
    count: archivedResponses.length,
    responses: archivedResponses
  });
}

async function handleResponsesCsv(req, res) {
  const archivedResponses = await readSurveyResponses();
  const questionIds = getSurveyQuestions().map((question) => question.id);
  const header = ["id", "submittedAt", "age", "gender", "respondentName", "respondentPhone", "privacyConsent", ...questionIds];
  const rows = archivedResponses.map((row) => {
    const answers = row.answers || {};
    return header.map((key) => {
      if (questionIds.includes(key)) {
        const value = answers[key];
        return csvCell(Array.isArray(value) ? value.join("; ") : value);
      }
      return csvCell(row[key]);
    }).join(",");
  });
  const body = `${header.join(",")}\n${rows.join("\n")}\n`;
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": 'attachment; filename="survey-responses.csv"'
  });
  res.end(body);
}

function handleConfig(req, res) {
  json(res, 200, {
    authMode: AUTH_MODE,
    allowMock: ALLOW_MOCK,
    surveyMode: SURVEY_MODE,
    minAge: MIN_AGE,
    maxAge: MAX_AGE,
    portOne: getPortOneConfigStatus(),
    externalSurveyUrl: EXTERNAL_SURVEY_URL,
    responsesFile: RESPONSES_FILE,
    storage: DATABASE_URL ? "postgres" : "jsonl"
  });
}

function handleExternalSurveyRedirect(req, res) {
  cleanupTokens();
  if (!EXTERNAL_SURVEY_URL) {
    json(res, 500, { message: "EXTERNAL_SURVEY_URL is required when SURVEY_MODE=EXTERNAL" });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get("token") || "";
  const tokenEntry = gateTokens.get(token);
  if (!tokenEntry || tokenEntry.used) {
    html(res, pageMessage("유효하지 않은 설문 입장 링크", "본인인증을 다시 진행해 주세요."));
    return;
  }

  tokenEntry.used = true;
  const target = appendGateToken(EXTERNAL_SURVEY_URL, token);
  res.writeHead(302, { Location: target });
  res.end();
}

function pageMessage(title, message) {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: #f4f7f9;
      color: #162033;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(560px, 100%);
      background: #fff;
      border: 1px solid #d6dee8;
      border-radius: 8px;
      padding: 24px;
    }
    h1 { margin: 0 0 10px; font-size: 22px; }
    p { margin: 0 0 18px; color: #667085; line-height: 1.6; }
    a { color: #0b6bcb; font-weight: 800; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${message}</p>
    <a href="/">처음으로 돌아가기</a>
  </main>
</body>
</html>`;
}

function infoShell(title, activePath, content) {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root {
      --bg: #f4f7f9;
      --panel: #fff;
      --text: #162033;
      --muted: #667085;
      --line: #d6dee8;
      --brand: #0b6bcb;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
    }
    header {
      background: #10243d;
      color: #fff;
      padding: 22px 20px;
    }
    .wrap {
      width: min(940px, calc(100% - 32px));
      margin: 0 auto;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 26px;
      letter-spacing: 0;
    }
    header p {
      margin: 0;
      color: #d9e5f3;
      line-height: 1.5;
    }
    nav {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 18px;
    }
    nav a {
      border: 1px solid #8fb7e8;
      border-radius: 8px;
      padding: 10px 12px;
      color: #fff;
      text-decoration: none;
      font-weight: 800;
    }
    nav a.active {
      background: #e8f2ff;
      color: #083d78;
    }
    main {
      padding: 24px 0 48px;
    }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 22px;
      margin-top: 18px;
    }
    h2 {
      margin: 0 0 14px;
      font-size: 20px;
      letter-spacing: 0;
    }
    h3 {
      margin: 22px 0 8px;
      font-size: 17px;
      letter-spacing: 0;
    }
    p, li {
      color: var(--muted);
      line-height: 1.65;
    }
    ul, ol {
      padding-left: 22px;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 18px;
    }
    .button {
      display: inline-flex;
      align-items: center;
      min-height: 44px;
      border-radius: 6px;
      padding: 10px 14px;
      background: var(--brand);
      color: #fff;
      text-decoration: none;
      font-weight: 800;
    }
    .button.secondary {
      background: #00856f;
    }
    footer {
      padding: 22px 0 36px;
      color: var(--muted);
      font-size: 14px;
    }
    @media (max-width: 640px) {
      section { padding: 18px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="wrap">
      <h1>${SERVICE_NAME}</h1>
      <p>휴대폰 본인인증으로 연령 조건과 중복 참여 여부를 확인한 뒤 설문 참여를 안내하는 서비스입니다.</p>
      <nav aria-label="서비스 메뉴">
        <a class="${activePath === "/service" ? "active" : ""}" href="/service">서비스 소개</a>
        <a class="${activePath === "/?survey=external" ? "active" : ""}" href="/?survey=external">설문 참여</a>
        <a class="${activePath === "/privacy" ? "active" : ""}" href="/privacy">개인정보 처리방침</a>
        <a class="${activePath === "/terms" ? "active" : ""}" href="/terms">이용 안내</a>
        <a class="${activePath === "/refund" ? "active" : ""}" href="/refund">환불 정책</a>
      </nav>
    </div>
  </header>
  <main class="wrap">
    ${content}
  </main>
  <footer class="wrap">
    운영: ${OPERATOR_NAME} · 문의: ${OPERATOR_CONTACT}
  </footer>
</body>
</html>`;
}

function servicePage() {
  return infoShell("서비스 소개", "/service", `
    <section>
      <h2>서비스 개요</h2>
      <p>세대분야 현장형 국민대화는 대통령직속 국민통합위원회 세대젠더통합정책과에서 국민을 찾아가 우리사회 세대젠더분야의 갈등으로 부상되고 있는 주제에 대해 토론하고, 과제와 대안을 마련하기 위해 마련된 행사입니다.</p>
      <p>이번 행사는 청년을 대상으로 2026 청년이 마주한 대표적 어려움에 대해 토론을 진행하고자 하며, 행사의 참가 신청 접수 및 설문을 위해서 위 서비스가 운영됩니다.</p>
      <p>응답자는 휴대폰 본인인증을 거친 뒤, 확인된 생년월일 기준 만 ${MIN_AGE}~${MAX_AGE}세에 해당하는 경우에만 설문 참여 화면 또는 구글폼 응답 화면으로 이동합니다.</p>
      <p>본 서비스는 연령 조건 확인과 1인 1응답 관리를 위해 본인인증 결과의 최소 정보만 사용하며, 인증기관에서 제공하는 CI 또는 DI는 원문으로 저장하지 않고 해시 처리해 중복 여부 확인에만 사용합니다.</p>
      <div class="actions">
        <a class="button" href="/?survey=external">구글폼 연결형 설문 참여</a>
        <a class="button secondary" href="/?survey=internal">자체 설문 예비안 확인</a>
      </div>
    </section>
    <section>
      <h2>상품/서비스 정보</h2>
      <p>상품/서비스명: ${SERVICE_NAME}</p>
      <p>서비스 유형: 휴대폰 본인인증 기반 온라인 설문 참여 게이트</p>
      <p>제공 내용: 연령 조건 확인, 중복 참여 방지, 대상자 대상 구글 설문지 연결</p>
      <p>이용 대상: 만 ${MIN_AGE}~${MAX_AGE}세 설문 참여 대상자</p>
      <p>이용 금액: 응답자 무료</p>
      <p>설문 참여 URL: /?survey=external</p>
    </section>
    <section>
      <h2>사업자 정보</h2>
      <p>운영 주체: ${OPERATOR_NAME}</p>
      <p>사업자 정보: ${BUSINESS_INFO}</p>
      <p>고객 문의: ${OPERATOR_CONTACT}</p>
    </section>
    <section>
      <h2>참여 흐름</h2>
      <ol>
        <li>응답자가 서비스 페이지에서 개인정보 처리 안내를 확인합니다.</li>
        <li>휴대폰 본인인증을 진행합니다.</li>
        <li>서버가 포트원 본인인증 API로 인증 결과를 재조회합니다.</li>
        <li>확인된 생년월일로 연령 조건을 판정합니다.</li>
        <li>CI 또는 DI 해시값으로 중복 참여 여부를 확인합니다.</li>
        <li>대상자만 설문으로 이동합니다.</li>
      </ol>
    </section>
    <section>
      <h2>본인인증 사용 목적</h2>
      <p>본인인증은 설문 표본의 연령 조건을 정확히 확인하고, 동일인이 여러 차례 참여하는 것을 방지하기 위해 사용합니다. 전화번호, 주민등록번호 등 불필요한 원문 식별정보는 설문 응답과 함께 저장하지 않습니다.</p>
    </section>
    <section>
      <h2>이용약관</h2>
      <p>${SERVICE_NAME}는 특정 연령대 참여자를 대상으로 한 설문 참여 안내 서비스입니다. 참여자는 본인인증 및 개인정보 처리 안내에 동의한 뒤 설문에 참여할 수 있습니다.</p>
      <ul>
        <li>대상 연령에 해당하지 않는 경우 설문으로 이동할 수 없습니다.</li>
        <li>동일인으로 확인된 경우 중복 참여가 제한됩니다.</li>
        <li>허위 정보 입력, 우회 접속, 비정상적 접근은 제한될 수 있습니다.</li>
        <li>운영 방식에 따라 자체 설문 또는 구글폼 등 외부 설문 플랫폼으로 연결될 수 있습니다.</li>
      </ul>
    </section>
    <section>
      <h2>개인정보처리방침</h2>
      <p>${OPERATOR_NAME}는 ${SERVICE_NAME} 운영을 위해 필요한 최소한의 개인정보만 처리합니다.</p>
      <ul>
        <li>처리 목적: 설문 참여 대상 연령 확인, 동일인 중복 참여 방지, 설문 응답 접수 및 통계 분석</li>
        <li>본인인증 처리 항목: 생년월일, 성별, CI 또는 DI</li>
        <li>저장 방식: CI 또는 DI는 원문 저장 없이 단방향 해시로 변환</li>
        <li>설문 응답 항목: 구글 설문지에 입력한 응답 내용</li>
        <li>보유 기간: 설문 운영과 검증 목적 달성 후 지체 없이 파기하며, 구체적 기간은 발주처 기준과 관련 법령에 따릅니다.</li>
        <li>제3자 제공 및 위탁: 휴대폰 본인인증은 포트원 및 본인인증 PG사를 통해 처리될 수 있고, 구글폼 연결 시 설문 응답은 Google 서비스 환경에서 처리될 수 있습니다.</li>
      </ul>
      <p>개인정보 문의: ${OPERATOR_CONTACT}</p>
    </section>
    <section>
      <h2>환불 정책</h2>
      <p>${SERVICE_NAME}는 응답자에게 별도 결제를 요구하지 않는 무료 설문 참여 서비스입니다. 따라서 응답자에게 청구되는 상품 대금이나 환불 대상 결제금액은 없습니다.</p>
      <ul>
        <li>응답자 설문 참여 비용: 무료</li>
        <li>본인인증 비용: 서비스 운영 주체 부담</li>
        <li>응답자 대상 환불 대상: 해당 없음</li>
      </ul>
    </section>
  `);
}

function privacyPage() {
  return infoShell("개인정보 처리방침", "/privacy", `
    <section>
      <h2>개인정보 처리방침</h2>
      <p>${OPERATOR_NAME}는 ${SERVICE_NAME} 운영을 위해 필요한 최소한의 개인정보만 처리합니다. 최종 문안은 발주처와 개인정보 보호책임자 검토 후 확정해야 합니다.</p>
      <h3>처리 목적</h3>
      <ul>
        <li>설문 참여 대상 연령 확인</li>
        <li>동일인 중복 참여 방지</li>
        <li>설문 응답 접수 및 통계 분석</li>
      </ul>
      <h3>처리 항목</h3>
      <ul>
        <li>본인인증 결과: 생년월일, 성별, CI 또는 DI</li>
        <li>저장 방식: CI 또는 DI는 원문 저장 없이 단방향 해시로 변환</li>
        <li>설문 응답: 지역, 관심 의제, 자유 의견 등 설문 문항 응답</li>
      </ul>
      <h3>보유 및 이용 기간</h3>
      <p>설문 운영과 검증 목적 달성 후 지체 없이 파기합니다. 구체적인 보유 기간은 발주처 기준과 관련 법령에 따라 확정합니다.</p>
      <h3>제3자 제공 및 위탁</h3>
      <p>휴대폰 본인인증은 포트원 및 본인인증 PG사를 통해 처리될 수 있습니다. 설문을 구글폼으로 연결하는 경우 설문 응답은 Google 서비스 환경에서 처리될 수 있습니다.</p>
      <h3>문의</h3>
      <p>개인정보 관련 문의: ${OPERATOR_CONTACT}</p>
    </section>
  `);
}

function termsPage() {
  return infoShell("이용 안내", "/terms", `
    <section>
      <h2>이용 안내</h2>
      <p>${SERVICE_NAME}는 특정 연령대 참여자를 대상으로 한 설문 참여 안내 서비스입니다. 참여자는 본인인증 및 개인정보 처리 안내에 동의한 뒤 설문에 참여할 수 있습니다.</p>
      <h3>참여 대상</h3>
      <p>기본 참여 대상은 만 ${MIN_AGE}~${MAX_AGE}세입니다. 실제 운영 시 발주처 기준에 따라 연령 범위가 변경될 수 있습니다.</p>
      <h3>참여 제한</h3>
      <ul>
        <li>대상 연령에 해당하지 않는 경우 설문으로 이동할 수 없습니다.</li>
        <li>동일인으로 확인된 경우 중복 참여가 제한됩니다.</li>
        <li>허위 정보 입력, 우회 접속, 비정상적 접근은 제한될 수 있습니다.</li>
      </ul>
      <h3>설문 방식</h3>
      <p>운영 방식에 따라 자체 설문 또는 구글폼 등 외부 설문 플랫폼으로 연결될 수 있습니다.</p>
      <div class="actions">
        <a class="button" href="/?survey=external">설문 참여하기</a>
        <a class="button secondary" href="/privacy">개인정보 처리방침 보기</a>
      </div>
    </section>
  `);
}

function refundPage() {
  return infoShell("환불 정책", "/refund", `
    <section>
      <h2>환불 정책</h2>
      <p>${SERVICE_NAME}는 응답자에게 별도 결제를 요구하지 않는 무료 설문 참여 서비스입니다. 따라서 응답자에게 청구되는 상품 대금이나 환불 대상 결제금액은 없습니다.</p>
      <h3>유료 결제 여부</h3>
      <ul>
        <li>응답자 설문 참여 비용: 무료</li>
        <li>본인인증 비용: 서비스 운영 주체가 부담</li>
        <li>응답자 대상 환불 대상: 해당 없음</li>
      </ul>
      <h3>문의</h3>
      <p>결제, 환불, 설문 참여 관련 문의는 ${OPERATOR_CONTACT}로 연락해 주세요.</p>
    </section>
  `);
}

function normalizeSurveyMode(selectedSurveyMode = SURVEY_MODE) {
  if (selectedSurveyMode === "EXTERNAL" || selectedSurveyMode === "HYBRID") return selectedSurveyMode;
  return "INTERNAL";
}

function renderSurveyQuestion(question) {
  const id = `q_${question.id}`;
  const name = `q_${question.id}`;
  const required = question.required ? "required" : "";
  const requiredMark = question.required ? " <span class=\"required\">필수</span>" : "";
  const placeholder = question.placeholder ? ` placeholder="${escapeHtml(question.placeholder)}"` : "";
  const label = `${escapeHtml(question.label)}${requiredMark}`;

  if (question.type === "textarea") {
    return `<label for="${escapeHtml(id)}">${label}
      <textarea id="${escapeHtml(id)}" name="${escapeHtml(name)}" data-question-id="${escapeHtml(question.id)}" ${required}${placeholder}></textarea>
    </label>`;
  }

  if (question.type === "text") {
    return `<label for="${escapeHtml(id)}">${label}
      <input id="${escapeHtml(id)}" name="${escapeHtml(name)}" data-question-id="${escapeHtml(question.id)}" type="text" ${required}${placeholder}>
    </label>`;
  }

  if (question.type === "radio") {
    const options = question.options.map((option, index) => {
      const optionId = `${id}_${index}`;
      return `<label class="choice" for="${escapeHtml(optionId)}">
        <input id="${escapeHtml(optionId)}" name="${escapeHtml(name)}" data-question-id="${escapeHtml(question.id)}" type="radio" value="${escapeHtml(option)}" ${required}>
        <span>${escapeHtml(option)}</span>
      </label>`;
    }).join("");
    return `<fieldset class="question-group">
      <legend>${label}</legend>
      <div class="choices">${options}</div>
    </fieldset>`;
  }

  if (question.type === "checkbox") {
    const options = question.options.map((option, index) => {
      const optionId = `${id}_${index}`;
      return `<label class="choice" for="${escapeHtml(optionId)}">
        <input id="${escapeHtml(optionId)}" name="${escapeHtml(name)}" data-question-id="${escapeHtml(question.id)}" type="checkbox" value="${escapeHtml(option)}">
        <span>${escapeHtml(option)}</span>
      </label>`;
    }).join("");
    return `<fieldset class="question-group">
      <legend>${label}</legend>
      <div class="choices">${options}</div>
    </fieldset>`;
  }

  return "";
}

function renderInternalSurveyForm(effectiveSurveyMode) {
  const sections = SURVEY_SCHEMA.sections.map((section) => `
    <div class="survey-block">
      <h3>${escapeHtml(section.title)}</h3>
      ${section.description ? `<p>${escapeHtml(section.description)}</p>` : ""}
      <div class="question-list">
        ${section.questions.map(renderSurveyQuestion).join("")}
      </div>
    </div>
  `).join("");

  return `
    <h2>2. ${effectiveSurveyMode === "HYBRID" ? "자체 설문" : "설문"}</h2>
    ${effectiveSurveyMode === "HYBRID" ? `<p>먼저 자체 설문으로 응답을 저장합니다. 제출 오류가 발생하거나 운영자가 구글폼 수집으로 전환해야 하는 경우, 같은 인증 토큰으로 구글폼 대체 이동을 제공합니다.</p>` : ""}
    <form id="surveyForm">
      <input name="token" type="hidden">
      ${sections}
      <div class="survey-actions">
        <button id="submitBtn" class="secondary" type="submit">설문 제출</button>
        ${effectiveSurveyMode === "HYBRID" ? `<button id="fallbackSurveyBtn" type="button" disabled>오류 시 구글폼으로 이동</button>` : ""}
      </div>
      <div id="surveyStatus" class="status" role="status" aria-live="polite"></div>
    </form>
    <p class="small">관리 확인용 응답 JSON: <a href="/admin/responses" target="_blank" rel="noreferrer">/admin/responses</a> · CSV: <a href="/admin/responses.csv" target="_blank" rel="noreferrer">/admin/responses.csv</a></p>`;
}

function identityVerificationRedirectPage(selectedSurveyMode = SURVEY_MODE) {
  const effectiveSurveyMode = normalizeSurveyMode(selectedSurveyMode);
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>본인인증 완료 처리</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: #f4f7f9;
      color: #162033;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(560px, 100%);
      background: #fff;
      border: 1px solid #d6dee8;
      border-radius: 8px;
      padding: 24px;
    }
    h1 { margin: 0 0 10px; font-size: 22px; }
    p { margin: 0 0 18px; color: #667085; line-height: 1.6; }
    .ok { color: #067647; font-weight: 800; }
    .fail { color: #b42318; font-weight: 800; }
    a {
      display: inline-block;
      min-height: 44px;
      padding: 12px 16px;
      border-radius: 6px;
      background: #0b6bcb;
      color: #fff;
      text-decoration: none;
      font-weight: 800;
    }
  </style>
</head>
<body>
  <main>
    <h1>본인인증 완료 처리</h1>
    <p id="message">인증 결과를 서버에서 확인하고 있습니다.</p>
    <a id="nextLink" href="/?survey=${effectiveSurveyMode.toLowerCase()}" style="display:none">설문으로 이동</a>
  </main>
  <script>
    const message = document.querySelector("#message");
    const nextLink = document.querySelector("#nextLink");
    const params = new URLSearchParams(location.search);
    const identityVerificationId = params.get("identityVerificationId");

    async function verify() {
      if (!identityVerificationId) {
        message.className = "fail";
        message.textContent = "본인인증 ID가 전달되지 않았습니다. 처음부터 다시 진행해 주세요.";
        nextLink.style.display = "inline-block";
        return;
      }

      try {
        const response = await fetch("/api/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identityVerificationId })
        });
        const data = await response.json();
        if (!response.ok || !data.pass) {
          message.className = "fail";
          message.textContent = data.message || "본인인증 검증에 실패했습니다.";
          nextLink.style.display = "inline-block";
          return;
        }

        message.className = "ok";
        message.textContent = "인증 완료: 만 " + data.age + "세 대상자입니다.";
        if (${JSON.stringify(effectiveSurveyMode)} === "EXTERNAL") {
          location.href = "/go?token=" + encodeURIComponent(data.token);
          return;
        }
        location.href = "/?survey=" + ${JSON.stringify(effectiveSurveyMode.toLowerCase())} + "&token=" + encodeURIComponent(data.token);
      } catch (error) {
        message.className = "fail";
        message.textContent = error.message || "인증 결과 확인 중 오류가 발생했습니다.";
        nextLink.style.display = "inline-block";
      }
    }

    verify();
  </script>
</body>
</html>`;
}

function page(selectedSurveyMode = SURVEY_MODE) {
  const effectiveSurveyMode = normalizeSurveyMode(selectedSurveyMode);
  const portOneConfig = getPortOneConfigStatus();
  const authReady = AUTH_MODE !== "REAL" || portOneConfig.ready;
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>국민대화 설문</title>
  <style>
    :root {
      --bg: #f4f7f9;
      --panel: #fff;
      --text: #162033;
      --muted: #667085;
      --line: #d6dee8;
      --brand: #0b6bcb;
      --brand2: #00856f;
      --danger: #b42318;
      --ok: #067647;
      --warn-bg: #fff8e8;
      --warn-line: #f1c978;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
    }
    header {
      background: #10243d;
      color: #fff;
      padding: 22px 20px;
    }
    .wrap {
      width: min(920px, calc(100% - 32px));
      margin: 0 auto;
    }
    header h1 {
      margin: 0 0 6px;
      font-size: 25px;
      letter-spacing: 0;
    }
    header p {
      margin: 0;
      color: #d9e5f3;
      line-height: 1.5;
    }
    main {
      padding: 24px 0 48px;
    }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 22px;
      margin-top: 18px;
    }
    h2 {
      margin: 0 0 14px;
      font-size: 20px;
      letter-spacing: 0;
    }
    p {
      color: var(--muted);
      line-height: 1.62;
    }
    form {
      display: grid;
      gap: 16px;
    }
    label {
      display: grid;
      gap: 8px;
      font-weight: 700;
    }
    fieldset {
      border: 0;
      margin: 0;
      padding: 0;
    }
    legend {
      margin: 0 0 10px;
      padding: 0;
      font-weight: 800;
      line-height: 1.45;
    }
    input, select, textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 11px 12px;
      min-height: 44px;
      font: inherit;
      color: var(--text);
      background: #fff;
    }
    textarea {
      min-height: 132px;
      resize: vertical;
      line-height: 1.55;
    }
    input[type="checkbox"] {
      width: 20px;
      min-height: 20px;
    }
    input[type="radio"] {
      width: 20px;
      min-height: 20px;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
    }
    .check {
      grid-template-columns: 20px 1fr;
      align-items: start;
      font-weight: 500;
      line-height: 1.55;
    }
    .survey-block {
      border-top: 1px solid var(--line);
      padding-top: 20px;
      margin-top: 22px;
    }
    .survey-block:first-of-type {
      border-top: 0;
      padding-top: 0;
      margin-top: 0;
    }
    .survey-block h3 {
      margin: 0 0 8px;
      font-size: 18px;
      letter-spacing: 0;
    }
    .question-list {
      display: grid;
      gap: 18px;
      margin-top: 16px;
    }
    .question-group {
      display: grid;
      gap: 8px;
    }
    .choices {
      display: grid;
      gap: 8px;
    }
    .choice {
      display: grid;
      grid-template-columns: 20px 1fr;
      align-items: start;
      gap: 9px;
      min-height: 32px;
      font-weight: 500;
      line-height: 1.5;
    }
    .required {
      display: inline-block;
      margin-left: 6px;
      color: var(--danger);
      font-size: 13px;
      font-weight: 800;
    }
    .survey-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 20px;
    }
    .notice {
      border: 1px solid var(--warn-line);
      background: var(--warn-bg);
      color: #6d4b05;
      border-radius: 8px;
      padding: 12px 14px;
      margin: 0 0 16px;
    }
    .notice.error {
      background: #fff1f0;
      border-color: #f2a6a0;
      color: #8a1f16;
    }
    button {
      border: 0;
      border-radius: 6px;
      min-height: 48px;
      padding: 0 18px;
      background: var(--brand);
      color: #fff;
      font: inherit;
      font-weight: 800;
      cursor: pointer;
    }
    button.secondary { background: var(--brand2); }
    button:disabled {
      opacity: .55;
      cursor: not-allowed;
    }
    .status {
      min-height: 24px;
      font-weight: 800;
      line-height: 1.55;
    }
    .ok { color: var(--ok); }
    .fail { color: var(--danger); }
    .hidden { display: none; }
    .small {
      font-size: 14px;
      color: var(--muted);
    }
    .mode-switch {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-top: 18px;
    }
    .mode-link {
      display: block;
      border: 1px solid #8fb7e8;
      border-radius: 8px;
      padding: 12px 14px;
      color: #0b4f9c;
      text-decoration: none;
      font-weight: 800;
      background: #fff;
    }
    .mode-link.active {
      background: #e8f2ff;
      border-color: var(--brand);
      color: #083d78;
    }
    @media (max-width: 640px) {
      .grid { grid-template-columns: 1fr; }
      .mode-switch { grid-template-columns: 1fr; }
      section { padding: 18px; }
    }
  </style>
  ${AUTH_MODE === "REAL" ? '<script src="https://cdn.portone.io/v2/browser-sdk.js"></script>' : ""}
</head>
<body>
  <header>
    <div class="wrap">
      <h1>${SERVICE_NAME}</h1>
      <p>본인인증으로 만 ${MIN_AGE}~${MAX_AGE}세 대상 여부를 확인한 뒤 설문을 제출합니다.</p>
      <nav class="mode-switch" aria-label="설문 방식 선택">
        <a class="mode-link ${effectiveSurveyMode === "EXTERNAL" ? "active" : ""}" href="/?survey=external">기본안: 구글폼 연결</a>
        <a class="mode-link ${effectiveSurveyMode === "HYBRID" ? "active" : ""}" href="/?survey=hybrid">대체안: 자체 설문 후 구글폼 백업</a>
        <a class="mode-link ${effectiveSurveyMode === "INTERNAL" ? "active" : ""}" href="/?survey=internal">예비안: 자체 설문만</a>
        <a class="mode-link" href="/service">서비스 소개</a>
        <a class="mode-link" href="/privacy">개인정보 처리방침</a>
      </nav>
    </div>
  </header>

  <main class="wrap">
    <section id="verifySection">
      <h2>1. 본인인증</h2>
      <p class="notice ${authReady ? "" : "error"}">현재 인증 모드: <strong>${AUTH_MODE}</strong>, 설문 방식: <strong>${effectiveSurveyMode}</strong>. ${AUTH_MODE === "REAL" ? "포트원 휴대폰 본인인증 SDK와 서버 재조회 API를 사용합니다." : "MOCK 모드는 실제 문자 발송 없이 생년월일과 휴대폰 번호로 테스트합니다."}</p>
      ${authReady ? "" : `<p class="notice error">실제 본인인증을 시작하려면 서버 실행 환경에 <strong>${portOneConfig.missing.join(", ")}</strong> 값을 설정해야 합니다.</p>`}
      <form id="verifyForm">
        <div id="mockFields" class="${AUTH_MODE === "MOCK" ? "" : "hidden"}">
          <div class="grid">
            <label>생년월일
              <input name="birthDate" type="date" value="2000-01-01">
            </label>
            <label>휴대폰 번호
              <input name="mockPhone" inputmode="tel" placeholder="01012345678" value="01012345678">
            </label>
          </div>
          <label>성별
            <select name="gender">
              <option value="MALE">남성</option>
              <option value="FEMALE">여성</option>
              <option value="OTHER">기타/미응답</option>
            </select>
          </label>
        </div>
        <label class="check">
          <input name="agree" type="checkbox">
          <span>본인인증 및 대상 여부 확인을 위한 최소 개인정보 처리에 동의합니다.</span>
        </label>
        <button id="verifyBtn" type="submit">본인인증 진행</button>
        <div id="verifyStatus" class="status" role="status" aria-live="polite"></div>
      </form>
    </section>

    <section id="surveySection" class="${effectiveSurveyMode === "EXTERNAL" ? "" : "hidden"}">
      ${effectiveSurveyMode === "EXTERNAL" ? `<h2>2. 구글폼 이동</h2>
      <p>본인인증을 통과하면 제공해 주신 구글폼 응답 링크로 이동합니다. 구글폼 편집은 운영자가 별도로 <a href="${GOOGLE_FORM_EDIT_URL}" target="_blank" rel="noreferrer">편집 링크</a>에서 진행합니다.</p>
      <p class="small">연결 대상: <a href="${EXTERNAL_SURVEY_URL}" target="_blank" rel="noreferrer">${EXTERNAL_SURVEY_URL}</a></p>
      <button id="externalSurveyBtn" class="secondary" type="button" disabled>인증 후 외부 설문 열기</button>
      <div id="surveyStatus" class="status" role="status" aria-live="polite"></div>` : renderInternalSurveyForm(effectiveSurveyMode)}
    </section>
  </main>

  <script>
    const config = {
      authMode: ${JSON.stringify(AUTH_MODE)},
      storeId: ${JSON.stringify(PORTONE_STORE_ID)},
      channelKey: ${JSON.stringify(PORTONE_CHANNEL_KEY)},
      publicBaseUrl: ${JSON.stringify(PUBLIC_BASE_URL)},
      surveyMode: ${JSON.stringify(effectiveSurveyMode)},
      minAge: ${JSON.stringify(MIN_AGE)}
    };
    const verifyForm = document.querySelector("#verifyForm");
    const surveyForm = document.querySelector("#surveyForm");
    const verifyStatus = document.querySelector("#verifyStatus");
    const surveyStatus = document.querySelector("#surveyStatus");
    const verifyBtn = document.querySelector("#verifyBtn");
    const submitBtn = document.querySelector("#submitBtn");
    const externalSurveyBtn = document.querySelector("#externalSurveyBtn");
    const fallbackSurveyBtn = document.querySelector("#fallbackSurveyBtn");
    const surveySection = document.querySelector("#surveySection");
    let verifiedToken = "";
    const existingToken = new URLSearchParams(location.search).get("token");
    if (existingToken && surveyForm) {
      verifiedToken = existingToken;
      surveyForm.elements.token.value = existingToken;
      setStatus(verifyStatus, "본인인증이 완료되었습니다. 설문을 작성해 주세요.", true);
      surveySection.classList.remove("hidden");
    }

    function setStatus(node, message, ok) {
      node.textContent = message;
      node.className = "status " + (ok ? "ok" : "fail");
    }

    function collectSurveyAnswers(form) {
      const answers = {};
      const fields = form.querySelectorAll("[data-question-id]");
      fields.forEach((field) => {
        const questionId = field.dataset.questionId;
        if (field.type === "checkbox") {
          if (!answers[questionId]) answers[questionId] = [];
          if (field.checked) answers[questionId].push(field.value);
          return;
        }
        if (field.type === "radio") {
          if (field.checked) answers[questionId] = field.value;
          return;
        }
        answers[questionId] = field.value;
      });
      return answers;
    }

    verifyForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      verifyStatus.textContent = "";
      if (!verifyForm.elements.agree.checked) {
        setStatus(verifyStatus, "개인정보 처리 동의가 필요합니다.", false);
        return;
      }

      verifyBtn.disabled = true;
      try {
        let payload = {};
        if (config.authMode === "REAL") {
          if (!window.PortOne) throw new Error("포트원 SDK를 불러오지 못했습니다.");
          if (!config.storeId || !config.channelKey) throw new Error("포트원 storeId/channelKey가 설정되지 않았습니다.");
          const identityVerificationId = "survey-" + crypto.randomUUID();
          const requestPayload = {
            storeId: config.storeId,
            channelKey: config.channelKey,
            identityVerificationId,
            bypass: {
              danal: {
                AGELIMIT: config.minAge,
                CPTITLE: config.publicBaseUrl || location.origin
              }
            }
          };
          const baseUrl = config.publicBaseUrl || location.origin;
          if (baseUrl.startsWith("https://")) {
            requestPayload.redirectUrl = baseUrl + "/identity-verification-redirect?survey=" + encodeURIComponent(config.surveyMode);
          }
          const result = await PortOne.requestIdentityVerification(requestPayload);
          if (result && result.code !== undefined) {
            throw new Error(result.message || "본인인증이 취소되었습니다.");
          }
          payload = { identityVerificationId };
        } else {
          payload = {
            birthDate: verifyForm.elements.birthDate.value,
            mockPhone: verifyForm.elements.mockPhone.value,
            gender: verifyForm.elements.gender.value
          };
        }

        const response = await fetch("/api/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok || !data.pass) {
          setStatus(verifyStatus, data.message || "본인인증에 실패했습니다.", false);
          return;
        }

        verifiedToken = data.token;
        if (externalSurveyBtn) {
          externalSurveyBtn.disabled = false;
        }
        if (surveyForm) {
          surveyForm.elements.token.value = data.token;
        }
        setStatus(verifyStatus, "인증 완료: 만 " + data.age + "세 대상자입니다.", true);
        surveySection.classList.remove("hidden");
        surveySection.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (error) {
        setStatus(verifyStatus, error.message || "본인인증 처리 중 오류가 발생했습니다.", false);
      } finally {
        verifyBtn.disabled = false;
      }
    });

    if (externalSurveyBtn) {
      externalSurveyBtn.addEventListener("click", () => {
        if (!verifiedToken) {
          setStatus(surveyStatus, "본인인증을 먼저 완료해 주세요.", false);
          return;
        }
        window.location.href = "/go?token=" + encodeURIComponent(verifiedToken);
      });
    }

    if (fallbackSurveyBtn) {
      fallbackSurveyBtn.addEventListener("click", () => {
        if (!verifiedToken) {
          setStatus(surveyStatus, "본인인증을 먼저 완료해 주세요.", false);
          return;
        }
        window.location.href = "/go?token=" + encodeURIComponent(verifiedToken);
      });
    }

    if (surveyForm) surveyForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      surveyStatus.textContent = "";
      submitBtn.disabled = true;
      try {
        const payload = {
          token: surveyForm.elements.token.value,
          answers: collectSurveyAnswers(surveyForm)
        };
        const response = await fetch("/api/survey", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok || !data.ok) {
          setStatus(surveyStatus, data.message || "설문 제출에 실패했습니다.", false);
          if (fallbackSurveyBtn) fallbackSurveyBtn.disabled = false;
          return;
        }
        setStatus(surveyStatus, data.message, true);
        surveyForm.reset();
        submitBtn.disabled = true;
      } catch (error) {
        setStatus(surveyStatus, error.message || "설문 제출 중 오류가 발생했습니다.", false);
        if (fallbackSurveyBtn) fallbackSurveyBtn.disabled = false;
        submitBtn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

async function router(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "HEAD") {
    const htmlPaths = new Set(["/", "/service", "/privacy", "/terms", "/refund", "/identity-verification-redirect"]);
    if (htmlPaths.has(url.pathname)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end();
    }
    if (url.pathname === "/api/config") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end();
    }
  }
  if (req.method === "GET" && url.pathname === "/service") return html(res, servicePage());
  if (req.method === "GET" && url.pathname === "/privacy") return html(res, privacyPage());
  if (req.method === "GET" && url.pathname === "/terms") return html(res, termsPage());
  if (req.method === "GET" && url.pathname === "/refund") return html(res, refundPage());
  if (req.method === "GET" && url.pathname === "/") {
    const selectedSurveyMode = String(url.searchParams.get("survey") || SURVEY_MODE).toUpperCase();
    return html(res, page(selectedSurveyMode));
  }
  if (req.method === "GET" && url.pathname === "/identity-verification-redirect") {
    const selectedSurveyMode = String(url.searchParams.get("survey") || SURVEY_MODE).toUpperCase();
    return html(res, identityVerificationRedirectPage(selectedSurveyMode));
  }
  if (req.method === "GET" && url.pathname === "/go") return handleExternalSurveyRedirect(req, res);
  if (req.method === "GET" && url.pathname === "/api/config") return handleConfig(req, res);
  if (req.method === "POST" && url.pathname === "/api/verify") return handleVerify(req, res);
  if (req.method === "POST" && url.pathname === "/api/survey") return handleSubmit(req, res);
  if (req.method === "GET" && url.pathname === "/admin/responses") {
    if (!requireAdmin(req, res)) return;
    return handleResponses(req, res);
  }
  if (req.method === "GET" && url.pathname === "/admin/responses.csv") {
    if (!requireAdmin(req, res)) return;
    return handleResponsesCsv(req, res);
  }
  json(res, 404, { message: "Not found" });
}

if (require.main === module) {
  http.createServer(router).listen(PORT, () => {
    console.log(`Survey identity app running at http://localhost:${PORT}`);
    console.log(`AUTH_MODE=${AUTH_MODE}, age=${MIN_AGE}-${MAX_AGE}`);
  });
}

module.exports = {
  calcKoreanAge,
  router
};

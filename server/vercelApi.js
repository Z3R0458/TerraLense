import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  fetchMonthlyPowerData,
  validatePowerRequest,
} from "../src/nasaPower.js";
import { validateChart, computeEvidence } from "./climateEvidence.js";
import { generateGeminiAnswer, assembleGroundedAnswer } from "./gemini.js";
import { loadServerConfig } from "./config.js";
import { ApiError } from "./errors.js";

const SESSION_TTL = 30 * 60 * 1000;
const SUMMARY_QUESTION =
  "Generate a climate overview covering temperature, precipitation, seasonal patterns, notable historical changes, cautious general agricultural considerations, and data limitations. Distinguish observations, statistical trends, and general climate knowledge.";
const MAX_BODY_BYTES = 16_000;
const MAX_HISTORY_MESSAGES = 8;

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

async function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || ""))
    throw new ApiError(415, "JSON_REQUIRED", "Send a JSON request.");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES)
      throw new ApiError(
        413,
        "BODY_LIMIT",
        "The request is too large. Keep the question and chat history shorter.",
      );
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "The request is not valid JSON.");
  }
}

function signature(secret, value) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(left, right) {
  const first = Buffer.from(String(left));
  const second = Buffer.from(String(right));
  return first.length === second.length && timingSafeEqual(first, second);
}

function issueDatasetId(secret, payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signature(secret, encoded)}`;
}

function verifyDatasetId(secret, token) {
  if (typeof token !== "string" || token.length > 2048)
    throw new ApiError(400, "INVALID_DATASET", "Fetch NASA data again.");
  const [encoded, suppliedSignature, extra] = token.split(".");
  if (!encoded || !suppliedSignature || extra || !safeEqual(suppliedSignature, signature(secret, encoded)))
    throw new ApiError(401, "DATASET_EXPIRED", "Fetch NASA data again.");
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new ApiError(401, "DATASET_EXPIRED", "Fetch NASA data again.");
  }
  if (
    !payload ||
    !Number.isFinite(payload.latitude) ||
    !Number.isFinite(payload.longitude) ||
    !Number.isInteger(payload.startYear) ||
    !Number.isInteger(payload.endYear) ||
    !Number.isFinite(payload.expiresAt) ||
    payload.expiresAt <= Date.now() ||
    typeof payload.sessionHash !== "string"
  )
    throw new ApiError(401, "DATASET_EXPIRED", "Fetch NASA data again.");
  return payload;
}

function readCsrfCookie(req, secret, now) {
  const item = (req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("terralens_session=")),
    value = item?.slice("terralens_session=".length) || "",
    [csrf, expiresAtText, suppliedSignature, extra] = value.split("."),
    expiresAt = Number(expiresAtText),
    csrfHeader = String(req.headers["x-terralens-csrf"] || "");
  if (
    extra ||
    !/^[a-f0-9]{48}$/.test(csrf || "") ||
    csrf !== csrfHeader ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    !safeEqual(
      suppliedSignature,
      signature(secret, `${csrf}.${expiresAtText}`),
    )
  )
    throw new ApiError(
      401,
      "SESSION_EXPIRED",
      "The assistant session expired. Reload the page and fetch NASA data again.",
    );
  return csrf;
}

function clientAddress(req) {
  const fromVercel =
    process.env.VERCEL === "1" &&
    (req.headers["x-vercel-forwarded-for"] || req.headers["x-forwarded-for"]);
  return String(fromVercel || req.socket.remoteAddress || "unknown")
    .split(",")[0]
    .trim();
}

function validateHistory(history) {
  if (history === undefined) return [];
  if (!Array.isArray(history) || history.length > MAX_HISTORY_MESSAGES)
    throw new ApiError(400, "INVALID_HISTORY", "Chat history is too long.");
  let remaining = 8000;
  const normalized = [];
  for (const message of history.slice(-MAX_HISTORY_MESSAGES)) {
    if (
      !message ||
      !["user", "assistant"].includes(message.role) ||
      typeof message.text !== "string"
    )
      throw new ApiError(400, "INVALID_HISTORY", "Chat history is invalid.");
    if (remaining <= 0) break;
    const text = message.text.slice(0, Math.min(2000, remaining));
    remaining -= text.length;
    normalized.push({ role: message.role, text });
  }
  return normalized;
}

export function createVercelApiRoute(pathname, dependencies = {}) {
  const getConfig = dependencies.getConfig || loadServerConfig,
    fetchPower = dependencies.fetchPower || fetchMonthlyPowerData,
    generate = dependencies.generate || generateGeminiAnswer,
    now = dependencies.now || Date.now,
    rates = new Map();
  let inflight = 0;

  function rate(req, category, limit) {
    const key = `${clientAddress(req)}:${category}`,
      time = now();
    let entry = rates.get(key);
    if (!entry || time - entry.at >= 60_000) {
      entry = { at: time, count: 0 };
      rates.set(key, entry);
    }
    if (++entry.count > limit)
      throw new ApiError(
        429,
        "RATE_LIMIT",
        "Too many requests. Please wait a minute before trying again.",
      );
    if (rates.size > 5000) rates.delete(rates.keys().next().value);
  }

  async function dispatch(req, res) {
    const config = getConfig(),
      forwardedProto = String(req.headers["x-forwarded-proto"] || "")
        .split(",")[0]
        .trim(),
      protocol = forwardedProto === "https" || req.socket.encrypted ? "https" : "http",
      expected = config.origin || `${protocol}://${req.headers.host}`;
    if (
      req.headers["sec-fetch-site"] === "cross-site" ||
      (req.headers.origin && req.headers.origin !== expected)
    )
      throw new ApiError(
        403,
        "ORIGIN",
        "This endpoint only accepts requests from TerraLens.",
      );

    if (req.method === "GET" && pathname === "/api/assistant/status")
      return send(res, 200, {
        success: true,
        status: "online",
        configured: Boolean(config.key),
        model: config.model,
        stateless: true,
      });
    if (req.method !== "POST")
      throw new ApiError(405, "METHOD", "Use POST for this endpoint.");

    const body = await readJson(req);
    if (pathname === "/api/assistant/session") {
      if (!exactKeys(body, []))
        throw new ApiError(400, "INVALID_SESSION", "The session request must be empty.");
      if (!config.key)
        throw new ApiError(
          503,
          "AI_NOT_CONFIGURED",
          "Gemini is not configured for this Vercel deployment. Set GEMINI_API_KEY and redeploy.",
        );
      rate(req, "session", 20);
      const csrf = randomBytes(24).toString("hex"),
        expiresAt = now() + SESSION_TTL,
        cookieSignature = signature(config.key, `${csrf}.${expiresAt}`),
        secure = protocol === "https";
      res.setHeader(
        "set-cookie",
        `terralens_session=${csrf}.${expiresAt}.${cookieSignature}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800${secure ? "; Secure" : ""}`,
      );
      return send(res, 200, {
        csrf,
        expiresAt,
        configured: true,
        model: config.model,
        stateless: true,
      });
    }

    if (!config.key)
      throw new ApiError(
        503,
        "AI_NOT_CONFIGURED",
        "Gemini is not configured for this Vercel deployment. Set GEMINI_API_KEY and redeploy.",
      );
    const csrf = readCsrfCookie(req, config.key, now());
    if (pathname === "/api/datasets") {
      if (!exactKeys(body, ["latitude", "longitude", "startYear", "endYear", "parameter"]))
        throw new ApiError(400, "INVALID_DATASET", "Provide coordinates and historical years.");
      try {
        validatePowerRequest(body);
      } catch (error) {
        throw new ApiError(400, "INVALID_DATASET", error.message);
      }
      rate(req, "datasets", 12);
      let dataset;
      try {
        dataset = await fetchPower({ ...body, parameter: "T2M" });
      } catch {
        throw new ApiError(
          502,
          "NASA_UNAVAILABLE",
          "NASA POWER could not provide this location and period. Check the period, connection, and NASA service availability.",
        );
      }
      const expiresAt = now() + SESSION_TTL,
        datasetId = issueDatasetId(config.key, {
          latitude: body.latitude,
          longitude: body.longitude,
          startYear: body.startYear,
          endYear: body.endYear,
          expiresAt,
          sessionHash: createHash("sha256").update(csrf).digest("hex"),
        });
      return send(res, 200, { datasetId, expiresAt, dataset });
    }

    if (!exactKeys(body, pathname.endsWith("/clear") ? ["datasetId"] : ["datasetId", "question", "chart", "mode", "history"]))
      throw new ApiError(400, "INVALID_REQUEST", "The assistant request contains unsupported fields.");
    const datasetToken = verifyDatasetId(config.key, body.datasetId);
    if (
      datasetToken.sessionHash !==
      createHash("sha256").update(csrf).digest("hex")
    )
      throw new ApiError(404, "DATASET_EXPIRED", "Fetch NASA POWER again.");
    if (pathname.endsWith("/clear")) return send(res, 200, { cleared: true });
    if (pathname !== "/api/assistant/chat")
      throw new ApiError(404, "NOT_FOUND", "The requested API endpoint was not found.");

    rate(req, "chat", 6);
    const mode = body.mode ?? "chat";
    if (!["chat", "summary"].includes(mode))
      throw new ApiError(400, "INVALID_MODE", "Choose a valid assistant request mode.");
    const question = mode === "summary" ? SUMMARY_QUESTION : body.question;
    if (
      typeof question !== "string" ||
      question.trim().length < 2 ||
      question.length > 2000 ||
      /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(question)
    )
      throw new ApiError(400, "INVALID_QUESTION", "Enter a question between 2 and 2000 characters.");
    const history = validateHistory(body.history);
    let dataset;
    try {
      dataset = await fetchPower({
        ...datasetToken,
        parameter: "T2M",
      });
    } catch {
      throw new ApiError(
        502,
        "NASA_UNAVAILABLE",
        "NASA POWER could not retrieve the verified dataset. Please fetch it again.",
      );
    }
    const chart = validateChart(body.chart, dataset);
    if (inflight >= 2)
      throw new ApiError(429, "AI_BUSY", "The assistant is busy. Please try again shortly.");
    const facts = computeEvidence(dataset, chart, question);
    if (JSON.stringify(facts).length > 220_000)
      throw new ApiError(400, "CONTEXT_LIMIT", "Select a shorter chart period for this question.");
    inflight++;
    try {
      const generated = await generate({
          config,
          question: question.trim(),
          history,
          facts,
          chart,
          mode,
        }),
        grounded = assembleGroundedAnswer(generated, facts, dataset.sourceUrl);
      return send(res, 200, {
        ...grounded,
        datasetId: body.datasetId,
        chart,
        model: config.model,
        generatedAt: new Date(now()).toISOString(),
        sourceUrl: dataset.sourceUrl,
      });
    } finally {
      inflight--;
    }
  }

  return function handler(req, res) {
    const original = new URL(req.url || "/", `https://${req.headers.host || "localhost"}`);
    req.url = `${pathname}${original.search}`;
    return dispatch(req, res).catch((error) => {
      const known = error instanceof ApiError,
        status = known ? error.status : 500;
      send(res, status, {
        error: {
          code: known ? error.code : "INTERNAL",
          message: known
            ? error.message
            : "The assistant could not process this request. Please try again.",
        },
      });
    });
  };
}

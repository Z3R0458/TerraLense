import {
  createHash,
  randomBytes,
  randomUUID,
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

const TTL = 30 * 60 * 1000;
const SUMMARY_QUESTION =
  "Generate a climate overview covering temperature, precipitation, seasonal patterns, notable historical changes, cautious general agricultural considerations, and data limitations. Distinguish observations, statistical trends, and general climate knowledge.";
function exactKeys(object, keys) {
  return (
    object &&
    typeof object === "object" &&
    !Array.isArray(object) &&
    Object.keys(object).every((key) => keys.includes(key))
  );
}
async function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || ""))
    throw new ApiError(415, "JSON_REQUIRED", "Send a JSON request.");
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 16000)
      throw new ApiError(
        413,
        "BODY_LIMIT",
        "The request is too large. Keep the question under 2000 characters.",
      );
    parts.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "The request is not valid JSON.");
  }
}
export function createAssistantApi({
  fetchPower = fetchMonthlyPowerData,
  generate = generateGeminiAnswer,
  getConfig = loadServerConfig,
  now = Date.now,
  rateLimits = {},
} = {}) {
  const sessions = new Map(),
    datasets = new Map(),
    rates = new Map();
  let inflight = 0;
  function prune() {
    const time = now();
    for (const [id, entry] of sessions)
      if (entry.expiresAt <= time) sessions.delete(id);
    for (const [id, entry] of datasets)
      if (entry.expiresAt <= time || !sessions.has(entry.owner))
        datasets.delete(id);
    for (const [key, value] of rates)
      if (time - value.at > 60000) rates.delete(key);
  }
  function rate(req, category, limit) {
    const key = `${req.socket.remoteAddress || "unknown"}:${category}`,
      time = now();
    let entry = rates.get(key);
    if (!entry || time - entry.at >= 60000) {
      entry = { at: time, count: 0 };
      rates.set(key, entry);
    }
    if (++entry.count > (rateLimits[category] ?? limit))
      throw new ApiError(
        429,
        "RATE_LIMIT",
        "Too many requests. Please wait a minute before trying again.",
      );
    if (rates.size > 5000) rates.delete(rates.keys().next().value);
  }
  function sessionFor(req) {
    const cookie = (req.headers.cookie || "")
      .split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith("terralens_session="));
    const id = cookie?.slice("terralens_session=".length),
      session = sessions.get(id);
    if (!session || session.expiresAt <= now())
      throw new ApiError(
        401,
        "SESSION_EXPIRED",
        "The assistant session expired. Reload your NASA dataset.",
      );
    return { id, ...session };
  }
  function send(res, status, body) {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    res.end(JSON.stringify(body));
  }
  return async function assistantApi(req, res, next) {
    let pathname;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      return next?.();
    }
    if (!pathname.startsWith("/api/")) {
      if (pathname.startsWith("/server/")) {
        res.writeHead(404);
        res.end();
        return;
      }
      return next?.();
    }
    try {
      prune();
      const config = getConfig();
      const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
        .split(",")[0]
        .trim();
      const requestProtocol =
        forwardedProto === "https" || req.socket.encrypted ? "https" : "http";
      const expected =
        config.origin || `${requestProtocol}://${req.headers.host}`;
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
          configured: Boolean(config.key),
          model: config.model,
        });
      if (req.method !== "POST")
        throw new ApiError(405, "METHOD", "Use POST for this endpoint.");
      const body = await readJson(req);
      if (pathname === "/api/assistant/session") {
        if (!exactKeys(body, []))
          throw new ApiError(
            400,
            "INVALID_SESSION",
            "The session request must be empty.",
          );
        rate(req, "session", 20);
        let existing;
        try {
          existing = sessionFor(req);
        } catch {}
        if (existing)
          return send(res, 200, {
            csrf: existing.csrf,
            expiresAt: existing.expiresAt,
            configured: Boolean(config.key),
            model: config.model,
          });
        if (sessions.size >= 500)
          throw new ApiError(
            503,
            "BUSY",
            "The assistant is busy. Please try again shortly.",
          );
        const id = randomBytes(32).toString("hex"),
          session = {
            csrf: randomBytes(24).toString("hex"),
            expiresAt: now() + TTL,
          };
        sessions.set(id, session);
        const secure = req.socket.encrypted || expected.startsWith("https:");
        res.setHeader(
          "set-cookie",
          `terralens_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800${secure ? "; Secure" : ""}`,
        );
        return send(res, 200, {
          csrf: session.csrf,
          expiresAt: session.expiresAt,
          configured: Boolean(config.key),
          model: config.model,
        });
      }
      const session = sessionFor(req),
        csrf = String(req.headers["x-terralens-csrf"] || "");
      if (
        !/^[a-f0-9]{48}$/.test(csrf) ||
        !timingSafeEqual(Buffer.from(csrf), Buffer.from(session.csrf))
      )
        throw new ApiError(
          403,
          "CSRF",
          "The request could not be verified. Reload the page.",
        );
      if (pathname === "/api/datasets") {
        if (
          !exactKeys(body, [
            "latitude",
            "longitude",
            "startYear",
            "endYear",
            "parameter",
          ])
        )
          throw new ApiError(
            400,
            "INVALID_DATASET",
            "Provide coordinates and years only, without climate measurements.",
          );
        try {
          validatePowerRequest(body);
        } catch (error) {
          throw new ApiError(400, "INVALID_DATASET", error.message);
        }
        rate(req, "datasets", 12);
        const fingerprint = JSON.stringify([
          body.latitude,
          body.longitude,
          body.startYear,
          body.endYear,
        ]);
        let record = [...datasets.values()].find(
          (item) =>
            item.owner === session.id && item.fingerprint === fingerprint,
        );
        if (!record) {
          if (datasets.size >= 100)
            throw new ApiError(
              503,
              "BUSY",
              "The dataset cache is full. Please try again shortly.",
            );
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
          const owned = [...datasets.values()].filter(
            (item) => item.owner === session.id,
          );
          if (owned.length >= 5) datasets.delete(owned[0].id);
          record = {
            id: randomUUID(),
            owner: session.id,
            fingerprint,
            dataset,
            expiresAt: now() + TTL,
            views: new Map(),
            histories: new Map(),
            answers: new Map(),
          };
          datasets.set(record.id, record);
        }
        return send(res, 200, {
          datasetId: record.id,
          expiresAt: record.expiresAt,
          dataset: record.dataset,
        });
      }
      if (!["/api/assistant/chat", "/api/assistant/clear"].includes(pathname))
        throw new ApiError(
          404,
          "NOT_FOUND",
          "The requested API endpoint was not found.",
        );
      if (
        !exactKeys(
          body,
          pathname.endsWith("/clear")
            ? ["datasetId"]
            : ["datasetId", "question", "chart", "mode"],
        )
      )
        throw new ApiError(
          400,
          "INVALID_REQUEST",
          "The assistant request contains unsupported fields.",
        );
      const record = datasets.get(body.datasetId);
      if (!record || record.owner !== session.id || record.expiresAt <= now())
        throw new ApiError(
          404,
          "DATASET_EXPIRED",
          "The verified dataset expired or does not belong to this session. Fetch NASA POWER again.",
        );
      if (pathname.endsWith("/clear")) {
        record.histories.clear();
        record.answers.clear();
        return send(res, 200, { cleared: true });
      }
      rate(req, "chat", 6);
      const mode = body.mode ?? "chat";
      if (!["chat", "summary"].includes(mode))
        throw new ApiError(
          400,
          "INVALID_MODE",
          "Choose a valid assistant request mode.",
        );
      const question = mode === "summary" ? SUMMARY_QUESTION : body.question;
      if (
        typeof question !== "string" ||
        question.trim().length < 2 ||
        question.length > 2000 ||
        /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(question)
      )
        throw new ApiError(
          400,
          "INVALID_QUESTION",
          "Enter a question between 2 and 2000 characters.",
        );
      const chart = validateChart(body.chart, record.dataset),
        viewKey = JSON.stringify(chart),
        history = record.histories.get(viewKey) || [];
      const historyHash = (items) =>
        createHash("sha256").update(JSON.stringify(items)).digest("hex");
      const cacheKey = `${mode}:${viewKey}:${question.trim()}:${mode === "summary" ? "summary" : historyHash(history)}`;
      if (record.answers.has(cacheKey))
        return send(res, 200, {
          ...record.answers.get(cacheKey),
          cached: true,
        });
      if (inflight >= 2 || record.busy)
        throw new ApiError(
          429,
          "AI_BUSY",
          "An AI answer is already being generated. Please wait for it to finish.",
        );
      let facts = record.views.get(viewKey);
      if (!facts) {
        facts = computeEvidence(record.dataset, chart);
        if (record.views.size >= 6)
          record.views.delete(record.views.keys().next().value);
        record.views.set(viewKey, facts);
      }
      if (/\b(?:19|20)\d{2}\b/.test(question))
        facts = computeEvidence(record.dataset, chart, question);
      if (JSON.stringify(facts).length > 220000)
        throw new ApiError(
          400,
          "CONTEXT_LIMIT",
          "Select a shorter chart period for this question.",
        );
      inflight++;
      record.busy = true;
      try {
        const generated = await generate({
          config,
          question: question.trim(),
          history: history.slice(-8),
          facts,
          chart,
          mode,
        });
        const grounded = assembleGroundedAnswer(
          generated,
          facts,
          record.dataset.sourceUrl,
        );
        const result = {
          ...grounded,
          datasetId: record.id,
          chart,
          model: config.model,
          generatedAt: new Date(now()).toISOString(),
          sourceUrl: record.dataset.sourceUrl,
        };
        const updatedHistory = [
          ...history,
          { role: "user", text: question.trim() },
          { role: "assistant", text: grounded.answer.slice(0, 5000) },
        ].slice(-8);
        if (record.histories.size >= 8 && !record.histories.has(viewKey))
          record.histories.delete(record.histories.keys().next().value);
        record.histories.set(viewKey, updatedHistory);
        while (record.answers.size >= 18)
          record.answers.delete(record.answers.keys().next().value);
        record.answers.set(cacheKey, result);
        if (mode === "chat")
          record.answers.set(
            `chat:${viewKey}:${question.trim()}:${historyHash(updatedHistory)}`,
            result,
          );
        return send(res, 200, result);
      } finally {
        inflight--;
        record.busy = false;
      }
    } catch (error) {
      const known = error instanceof ApiError;
      send(res, known ? error.status : 500, {
        error: {
          code: known ? error.code : "INTERNAL",
          message: known
            ? error.message
            : "The assistant could not process this request. Please try again.",
        },
      });
    }
  };
}

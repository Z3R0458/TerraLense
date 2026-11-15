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
import {
  createAssistantStore,
  StorageUnavailableError,
} from "./storage.js";

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
  store = createAssistantStore({ now }),
} = {}) {
  const storage = new Proxy(store, {
    get(target, property) {
      const original = target[property];
      if (property === "health")
        return async () => {
          try {
            return await original.call(target);
          } catch {
            return false;
          }
        };
      if (typeof original !== "function") return original;
      return async (...args) => {
        try {
          return await original.apply(target, args);
        } catch (error) {
          if (error instanceof StorageUnavailableError) throw error;
          throw new StorageUnavailableError();
        }
      };
    },
  });
  async function rate(req, category, limit) {
    const isVercel = process.env.VERCEL === "1",
      proxyAddress = isVercel
        ? req.headers["x-vercel-forwarded-for"] ||
          req.headers["x-forwarded-for"] ||
          req.socket.remoteAddress
        : req.socket.remoteAddress,
      address = String(proxyAddress || "unknown").split(",")[0].trim(),
      count = await storage.incrementRate(`${address}:${category}`, 60);
    if (count > (rateLimits[category] ?? limit))
      throw new ApiError(
        429,
        "RATE_LIMIT",
        "Too many requests. Please wait a minute before trying again.",
      );
  }
  async function sessionFor(req) {
    const cookie = (req.headers.cookie || "")
      .split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith("terralens_session="));
    const id = cookie?.slice("terralens_session=".length),
      session = id ? await storage.getSession(id) : null;
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
      if (req.method === "GET" && pathname === "/api/assistant/status") {
        let storageReady = false;
        try {
          storageReady = await storage.health();
        } catch {}
        return send(res, 200, {
          success: true,
          status: "online",
          configured: Boolean(config.key),
          model: config.model,
          storageConfigured: storageReady,
          storageShared: Boolean(storage.shared),
        });
      }
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
        await rate(req, "session", 20);
        let existing;
        try {
          existing = await sessionFor(req);
        } catch {}
        if (existing)
          return send(res, 200, {
            csrf: existing.csrf,
            expiresAt: existing.expiresAt,
            configured: Boolean(config.key),
            model: config.model,
          });
        const id = randomBytes(32).toString("hex"),
          session = {
            csrf: randomBytes(24).toString("hex"),
            expiresAt: now() + TTL,
          };
        await storage.setSession(id, session, Math.ceil(TTL / 1000));
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
      const session = await sessionFor(req),
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
        await rate(req, "datasets", 12);
        const fingerprint = JSON.stringify([
          body.latitude,
          body.longitude,
          body.startYear,
          body.endYear,
        ]);
        let record;
        for (const datasetId of await storage.getDatasetIds(session.id)) {
          const candidate = await storage.getDataset(datasetId);
          if (!candidate) {
            await storage.removeDatasetId(session.id, datasetId);
            continue;
          }
          if (candidate.owner === session.id && candidate.fingerprint === fingerprint) {
            record = candidate;
            break;
          }
        }
        if (!record) {
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
          const owned = await storage.getDatasetIds(session.id);
          if (owned.length >= 5) await storage.deleteDataset(owned[0]);
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
          await storage.setDataset(record, Math.ceil(TTL / 1000));
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
      const record = await storage.getDataset(body.datasetId);
      if (!record || record.owner !== session.id || record.expiresAt <= now())
        throw new ApiError(
          404,
          "DATASET_EXPIRED",
          "The verified dataset expired or does not belong to this session. Fetch NASA POWER again.",
        );
      if (pathname.endsWith("/clear")) {
        record.histories.clear();
        record.answers.clear();
        await storage.setDataset(
          record,
          Math.max(1, Math.ceil((record.expiresAt - now()) / 1000)),
        );
        return send(res, 200, { cleared: true });
      }
      await rate(req, "chat", 6);
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
      await storage.setDataset(
        record,
        Math.max(1, Math.ceil((record.expiresAt - now()) / 1000)),
      );
      const generationToken = randomUUID();
      if (!(await storage.acquireGeneration(record.id, generationToken, 2)))
        throw new ApiError(
          429,
          "AI_BUSY",
          "An AI answer is already being generated. Please wait for it to finish.",
        );
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
        await storage.setDataset(
          record,
          Math.max(1, Math.ceil((record.expiresAt - now()) / 1000)),
        );
        return send(res, 200, result);
      } finally {
        await storage.releaseGeneration(record.id, generationToken);
      }
    } catch (error) {
      const storageFailure = error instanceof StorageUnavailableError;
      const known = error instanceof ApiError || storageFailure;
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

import { fetchMonthlyPowerData } from "./nasaPower.js";

let sessionPromise;
export class AssistantError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
async function request(path, body, csrf) {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 65000);
  try {
    const response = await fetch(new URL(`api/${path}`, document.baseURI), {
      method: "POST",
      credentials: "same-origin",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(csrf ? { "x-terralens-csrf": csrf } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.headers.get("content-type")?.includes("application/json"))
      throw new AssistantError(
        "The TerraLens AI backend is unavailable. Start the application with npm run dev or npm start.",
        "BACKEND_UNAVAILABLE",
        response.status,
      );
    const result = await response.json();
    if (!response.ok) {
      if (result.error?.code === "SESSION_EXPIRED") sessionPromise = null;
      throw new AssistantError(
        result.error?.message || "The assistant request failed.",
        result.error?.code,
        response.status,
      );
    }
    return result;
  } catch (error) {
    if (error instanceof AssistantError) throw error;
    throw new AssistantError(
      error.name === "AbortError"
        ? "The assistant request timed out. Please try again."
        : "Could not reach the TerraLens AI server. Check your connection.",
      "BACKEND_UNAVAILABLE",
      0,
    );
  } finally {
    clearTimeout(timer);
  }
}
export async function assistantSession() {
  if (!sessionPromise)
    sessionPromise = request("assistant/session", {}).catch((error) => {
      sessionPromise = null;
      throw error;
    });
  const session = await sessionPromise;
  if (session.expiresAt <= Date.now() + 1000) {
    sessionPromise = null;
    return assistantSession();
  }
  return session;
}
export async function fetchVerifiedPowerData(parameters) {
  try {
    const session = await assistantSession();
    return await request("datasets", parameters, session.csrf);
  } catch (error) {
    // NASA charts remain available even when the Vercel AI state store is down.
    // The assistant itself still requires the backend and shared storage.
    if (
      !["BACKEND_UNAVAILABLE", "STORAGE_UNAVAILABLE", "AI_NOT_CONFIGURED"].includes(
        error.code,
      )
    )
      throw error;
    return {
      dataset: await fetchMonthlyPowerData(parameters),
      datasetId: null,
      backendUnavailable: true,
      backendError: error.code,
    };
  }
}
export async function askAssistant({
  datasetId,
  question,
  chart,
  history = [],
  mode = "chat",
}) {
  const session = await assistantSession();
  return request(
    "assistant/chat",
    {
      datasetId,
      question,
      chart,
      mode,
      ...(session.stateless ? { history } : {}),
    },
    session.csrf,
  );
}
export async function clearAssistant(datasetId) {
  const session = await assistantSession();
  return request("assistant/clear", { datasetId }, session.csrf);
}

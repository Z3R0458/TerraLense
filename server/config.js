import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function loadServerConfig() {
  // Never place credentials inside Apache's document root or use VITE_ secrets.
  const defaultFile =
    process.platform === "win32"
      ? path.join(
          process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"),
          "TerraLens",
          "server.env",
        )
      : path.join(homedir(), ".config", "terralens", "server.env");
  const values = {};
  try {
    for (const line of readFileSync(
      process.env.TERRALENS_ENV_FILE || defaultFile,
      "utf8",
    )
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (
        match &&
        [
          "GEMINI_API_KEY",
          "GEMINI_MODEL",
          "UPSTASH_REDIS_REST_URL",
          "UPSTASH_REDIS_REST_TOKEN",
          "HOST",
          "PORT",
          "ALLOWED_ORIGIN",
        ].includes(match[1])
      )
        values[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
    }
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error(
        "The private TerraLens server environment file could not be read.",
      );
  }
  const model =
    process.env.GEMINI_MODEL || values.GEMINI_MODEL || "gemini-3.1-flash-lite";
  if (!/^gemini-[a-z0-9.-]+$/.test(model))
    throw new Error("GEMINI_MODEL must be a Gemini model identifier.");
  return {
    key: process.env.GEMINI_API_KEY || values.GEMINI_API_KEY || "",
    model,
    redisUrl:
      process.env.UPSTASH_REDIS_REST_URL || values.UPSTASH_REDIS_REST_URL || "",
    redisToken:
      process.env.UPSTASH_REDIS_REST_TOKEN ||
      values.UPSTASH_REDIS_REST_TOKEN ||
      "",
    host: process.env.HOST || values.HOST || "127.0.0.1",
    port: Number(process.env.PORT || values.PORT || 8787),
    origin: process.env.ALLOWED_ORIGIN || values.ALLOWED_ORIGIN || "",
  };
}

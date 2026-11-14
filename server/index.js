import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantApi } from "./api.js";
import { loadServerConfig } from "./config.js";

const root = fileURLToPath(new URL("../dist/", import.meta.url));
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
const api = createAssistantApi();
export const server = http.createServer((req, res) => {
  api(req, res, async () => {
    try {
      if (!["GET", "HEAD"].includes(req.method)) {
        res.writeHead(405);
        res.end();
        return;
      }
      const pathname = decodeURIComponent(
        new URL(req.url, "http://localhost").pathname,
      );
      if (
        pathname !== "/" &&
        pathname !== "/index.html" &&
        !/^\/assets\/[a-zA-Z0-9_.-]+$/.test(pathname)
      ) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const file = path.resolve(
        root,
        pathname === "/" ? "index.html" : "." + pathname,
      );
      if (!file.startsWith(root)) {
        res.writeHead(404);
        res.end();
        return;
      }
      await stat(file);
      res.writeHead(200, {
        "content-type": types[path.extname(file)] || "application/octet-stream",
        "x-content-type-options": "nosniff",
        "referrer-policy": "same-origin",
        "cache-control": pathname.startsWith("/assets/")
          ? "public, max-age=3600"
          : "no-cache",
      });
      res.end(req.method === "HEAD" ? undefined : await readFile(file));
    } catch {
      res.writeHead(404);
      res.end(
        "Build TerraLens with npm run build before starting the production server.",
      );
    }
  });
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
const config = loadServerConfig();
server.listen(config.port, config.host, () =>
  console.log(
    `TerraLens: http://${config.host}:${config.port} (Gemini ${config.key ? "configured" : "not configured"})`,
  ),
);

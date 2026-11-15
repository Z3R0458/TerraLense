import { createAssistantApi } from "./api.js";
import { loadServerConfig } from "./config.js";
import { createAssistantStore } from "./storage.js";

const serverConfig = loadServerConfig();
const assistantApi = createAssistantApi({
  store: createAssistantStore({ config: serverConfig, requireShared: true }),
});

export function createVercelApiRoute(pathname) {
  return function handler(req, res) {
    const requestUrl = new URL(req.url || "/", `https://${req.headers.host || "localhost"}`);
    req.url = `${pathname}${requestUrl.search}`;
    return assistantApi(req, res);
  };
}

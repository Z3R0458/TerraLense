import { createAssistantApi } from "../server/api.js";
import { loadServerConfig } from "../server/config.js";
import { createAssistantStore } from "../server/storage.js";

// Keep every API path in one function and persist shared state in Redis.
const serverConfig = loadServerConfig();
const assistantApi = createAssistantApi({
  store: createAssistantStore({ config: serverConfig, requireShared: true }),
});

export const config = {
  api: { bodyParser: false },
};

export default function handler(req, res) {
  return assistantApi(req, res);
}

import { createAssistantApi } from "../server/api.js";

// Keep every API path in one Vercel function. The assistant API stores its
// short-lived sessions and verified datasets in this function's memory.
const assistantApi = createAssistantApi();

export const config = {
  api: { bodyParser: false },
};

export default function handler(req, res) {
  return assistantApi(req, res);
}

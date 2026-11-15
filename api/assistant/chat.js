import { createVercelApiRoute } from "../../server/vercelApi.js";

export const config = { api: { bodyParser: false } };
export default createVercelApiRoute("/api/assistant/chat");

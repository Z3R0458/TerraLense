TerraLens AI runs on the server. The Gemini key never belongs in a `VITE_` variable, browser storage, source file, or `dist/`.

## Deploy on Vercel

Vercel uses explicit function files under `api/`: `api/assistant/status.js`, `api/assistant/session.js`, `api/assistant/chat.js`, `api/assistant/clear.js`, and `api/datasets.js`. Each maps directly to its URL and delegates to the existing assistant API. In the Vercel project settings, add `GEMINI_API_KEY`, `UPSTASH_REDIS_REST_URL`, and `UPSTASH_REDIS_REST_TOKEN` as encrypted environment variables for Production (and Preview if you use preview deployments), then redeploy. Create a Redis database in Upstash and copy its REST URL and token from the database console. Optionally set `GEMINI_MODEL`; the default is `gemini-3.1-flash-lite`. Never use a `VITE_` prefix for secrets. Vercel builds the frontend into `dist/` and serves the functions from the root `api/` directory. Confirm the Vercel project's Root Directory points to this repository root, where both `api/` and `vercel.json` live.

The function detects the HTTPS origin from Vercel's forwarded request headers, so `ALLOWED_ORIGIN` is normally unnecessary. If you set it, use the exact deployed origin, including `https://` and no trailing slash. Sessions, CSRF tokens, verified NASA datasets, chat history, answer caches, rate limits, and generation locks are stored in Redis with expiry. Local Node use falls back to in-memory storage when the Upstash variables are absent; the Vercel function requires shared Redis and reports storage health separately from Gemini key configuration.

After deploying these project changes, open `https://your-deployment.vercel.app/api/assistant/status`. A JSON response with `"status": "online"`, `"configured": true`, and `"storageConfigured": true` means the function can see the Gemini key and reach Redis. `"configured": false` means the Vercel environment is missing `GEMINI_API_KEY`; `"storageConfigured": false` means the Upstash variables are missing or Redis is unreachable. A Vercel 404 means that deployment did not build the root `api/` function (check Root Directory and deploy the latest commit). Adding environment variables alone does not publish local code changes: commit and push the API, storage, and Vercel config changes, then redeploy.

Smoke-test the deployed status and the full session -> NASA dataset -> Gemini flow in PowerShell:

```powershell
curl.exe -i https://terralens-zeta.vercel.app/api/assistant/status
$base = "https://terralens-zeta.vercel.app"
$web = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$session = Invoke-RestMethod -Method Post -Uri "$base/api/assistant/session" -ContentType "application/json" -Body "{}" -WebSession $web
$headers = @{ "x-terralens-csrf" = $session.csrf }
$dataset = Invoke-RestMethod -Method Post -Uri "$base/api/datasets" -ContentType "application/json" -Headers $headers -Body '{"latitude":14.5,"longitude":121,"startYear":2020,"endYear":2022,"parameter":"T2M"}' -WebSession $web
$chat = @{ datasetId = $dataset.datasetId; question = "Summarize the verified temperature pattern."; chart = @{ type = "line"; parameter = "T2M"; resolution = "yearly"; startYear = 2020; endYear = 2022; grouping = "months" }; mode = "chat" } | ConvertTo-Json -Depth 6 -Compress
$answer = Invoke-RestMethod -Method Post -Uri "$base/api/assistant/chat" -ContentType "application/json" -Headers $headers -Body $chat -WebSession $web
$answer | Select-Object model, generatedAt, answer
```

`WebRequestSession` keeps the HttpOnly session cookie between requests, and the script sends the returned CSRF token on state-changing calls. Do not save real tokens or dataset responses in source control.

Use Node 22 or newer. `npm run dev` starts Vite and the assistant API together. For production, run `npm run build` followed by `npm start`; open `http://127.0.0.1:8787`. `npm run preview` also includes the API for local verification.

Set `GEMINI_API_KEY` and optionally `GEMINI_MODEL` in the server environment. The default model is `gemini-3.1-flash-lite`. Alternatively, place the variables from `.env.example` in a private file outside the web root:

- Windows: `%LOCALAPPDATA%\TerraLens\server.env`
- Linux/macOS: `~/.config/terralens/server.env`
- Custom location: set `TERRALENS_ENV_FILE` in the server process environment.

The private file is read for each API request, so changing its key does not require a restart. Process environment variables take precedence. Keep both Upstash credentials and the Gemini key out of source control and `.env.example`; the example file contains blank placeholders only.

Static hosting alone cannot run Gemini securely. For Apache, serve `dist/` and reverse-proxy the application's `/api/` requests to the Node server. For an installation at `/Terralens/`, a virtual-host configuration can include:

```apache
ProxyPass /Terralens/api/ http://127.0.0.1:8787/api/
ProxyPassReverse /Terralens/api/ http://127.0.0.1:8787/api/
Alias /Terralens/ "C:/Apache24/htdocs/Terralens/dist/"
```

Enable Apache's proxy and proxy_http modules and set `ALLOWED_ORIGIN` to the exact browser origin, for example `http://localhost` or `https://your-domain.example`. The Node server binds to loopback by default. Keep TLS and public access controls at the reverse proxy. The existing `.openai/hosting.json` still describes static assets; it cannot supply this Node API by itself. Without a backend, NASA visualization remains available directly, and the AI interface explains that its server is unavailable.

The backend independently fetches NASA POWER data, issues a session-owned dataset ID, and calculates evidence. Chat requests contain only that ID, a question, and validated chart controls. The client cannot submit climate readings or conversation history as evidence. Session cookies are HttpOnly and SameSite Strict; mutations require a CSRF token and a matching origin. Production HTTPS should use `ALLOWED_ORIGIN=https://…` to enable Secure cookies behind the proxy.

Sessions and datasets expire after thirty minutes. This single-process implementation bounds caches and conversation history, limits requests by the actual connecting IP, and allows two simultaneous Gemini generations. It does not trust forwarded IP headers. For a multi-instance/public deployment, move sessions and rate limits to shared storage and apply authenticated user limits at the proxy. Do not expose the development server publicly as a production service.

Gemini generates explanations and selects verified evidence IDs. TerraLens removes unsupported citations and numerical claims from model prose, then inserts exact application-calculated values, dates, and units. If no explanation survives validation, it returns a concise summary assembled from verified dataset evidence. General climate knowledge is separately labeled. This reduces unsupported numerical claims; qualitative AI explanations still require scientific judgment.

Questions and statistical evidence are sent to Google Gemini only when the user sends a message, clicks Ask AI, or requests AI Insights. NASA fetches and ordinary chart changes do not generate paid AI calls. The supplied API key and raw provider errors are never returned by the API.

Run `npm test` for aggregation, evidence, request-validation, ownership, rate-limit, and provider-error tests. Google project access, model availability, billing, quota, and network connectivity are required for live AI replies.

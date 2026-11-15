TerraLens AI runs on the server. The Gemini key never belongs in a `VITE_` variable, browser storage, source file, or `dist/`.

## Deploy on Vercel

The project includes a catch-all Vercel function at `api/[...path].js` for the assistant API. In the Vercel project settings, add `GEMINI_API_KEY` as an encrypted environment variable for the Production environment (and Preview if you use preview deployments), then redeploy. Optionally set `GEMINI_MODEL`; the default is `gemini-3.1-flash-lite`. Do not use a `VITE_` prefix. Vercel builds the frontend into `dist/` and serves `/api/*` through the Node function.

The function detects the HTTPS origin from Vercel's forwarded request headers, so `ALLOWED_ORIGIN` is normally unnecessary. If you set it, use the exact deployed origin, including `https://` and no trailing slash. The session and verified-dataset cache is in function memory and expires after thirty minutes; a function restart or a request routed to a different instance can require the user to reload and fetch the NASA dataset again. For deployments that need reliable multi-instance sessions, move this state to shared storage before enabling substantial traffic.

After deploying these project changes, open `https://your-deployment.vercel.app/api/assistant/status`. A JSON response with `"configured": true` means the API function is deployed and sees `GEMINI_API_KEY`; `"configured": false` means the Vercel environment variable is missing from that deployment environment. A Vercel 404 or non-JSON page means the function file was not included in the deployment. Adding the key in Vercel does not deploy local code changes: commit and push `api/[...path].js`, `vercel.json`, and the related server changes, then redeploy.

Use Node 22 or newer. `npm run dev` starts Vite and the assistant API together. For production, run `npm run build` followed by `npm start`; open `http://127.0.0.1:8787`. `npm run preview` also includes the API for local verification.

Set `GEMINI_API_KEY` and optionally `GEMINI_MODEL` in the server environment. The default model is `gemini-3.1-flash-lite`. Alternatively, place the variables from `.env.example` in a private file outside the web root:

- Windows: `%LOCALAPPDATA%\TerraLens\server.env`
- Linux/macOS: `~/.config/terralens/server.env`
- Custom location: set `TERRALENS_ENV_FILE` in the server process environment.

The private file is read for each API request, so changing its key does not require a restart. Process environment variables take precedence. Do not copy a real key into the project's `.env.example`.

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

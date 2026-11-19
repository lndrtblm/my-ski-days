// POST /api/refresh: start the cloud job that fetches new sessions from Carv (unless one is already running).
import { allowed, gh, latestRun, json } from "./_github.js";

export async function onRequestPost({ request, env }) {
  if (!allowed(request, env)) return json({ error: "not allowed" }, 403);
  try {
    const run = await latestRun(env);
    if (run && run.status !== "completed") return json({ started: false, run });
    const res = await gh(env, "/actions/workflows/update.yml/dispatches", { method: "POST", body: JSON.stringify({ ref: "main" }) });
    if (!res.ok) return json({ error: `GitHub ${res.status}` }, 502);
    return json({ started: true, at: new Date().toISOString() });
  } catch (e) {
    return json({ error: String(e.message || e) }, 502);
  }
}

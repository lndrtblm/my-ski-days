// GET /api/status: state of the latest cloud job (queued / in_progress / completed + success or failure).
import { allowed, latestRun, json } from "./_github.js";

export async function onRequestGet({ request, env }) {
  if (!allowed(request, env)) return json({ error: "not allowed" }, 403);
  try {
    return json({ run: await latestRun(env) });
  } catch (e) {
    return json({ error: String(e.message || e) }, 502);
  }
}

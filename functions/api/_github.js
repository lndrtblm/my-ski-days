// Shared helpers for the Refresh button (Cloudflare Pages Functions).
// Only a device that knows the app password can compute the proof (see app.js refreshProof),
// so strangers cannot start the cloud job. The GitHub token never leaves Cloudflare.

export function allowed(request, env) {
  const proof = request.headers.get("x-refresh-proof") || "";
  const want = env.REFRESH_PROOF || "";
  if (!want || proof.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= proof.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

export async function gh(env, path, init = {}) {
  const res = await fetch(`https://api.github.com/repos/${env.GH_REPO}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "my-ski-days-refresh",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  return res;
}

export async function latestRun(env) {
  const res = await gh(env, "/actions/workflows/update.yml/runs?per_page=1");
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const run = (await res.json()).workflow_runs?.[0];
  return run ? { status: run.status, conclusion: run.conclusion, created: run.created_at, updated: run.updated_at, event: run.event } : null;
}

export const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});

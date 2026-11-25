const REPO = "https://api.github.com/repos/ProjectJJU/CourtWatch";

function headers(token) {
  return {
    Authorization: "Bearer " + token,
    Accept: "application/vnd.github+json",
    "User-Agent": "court-watch",
  };
}

const STALE_QUEUE_MS = 60 * 1000;
const WAITING = new Set(["queued", "pending", "waiting", "requested"]);

function waitingTooLong(run, now) {
  if (!WAITING.has(run.status)) return false;
  const created = Date.parse(run.created_at || "");
  return Number.isFinite(created) && now - created > STALE_QUEUE_MS;
}

async function listRuns(token) {
  const response = await fetch(
    REPO + "/actions/workflows/check.yml/runs?per_page=20",
    { headers: headers(token) }
  );
  if (!response.ok) {
    console.log("runs", response.status);
    return null;
  }
  const payload = await response.json();
  return payload.workflow_runs || [];
}

async function cancelRun(token, id) {
  const response = await fetch(REPO + "/actions/runs/" + id + "/cancel", {
    method: "POST",
    headers: headers(token),
  });
  console.log("cancel", id, response.status);
}

export default {
  async scheduled(_event, env) {
    const runs = await listRuns(env.GITHUB_TOKEN);
    if (!runs) return;
    const now = Date.now();
    for (const run of runs) {
      if (waitingTooLong(run, now)) await cancelRun(env.GITHUB_TOKEN, run.id);
    }
    const busy = runs.some(
      (run) => run.status && run.status !== "completed" && !waitingTooLong(run, now)
    );
    if (busy) {
      console.log("skip busy");
      return;
    }
    const response = await fetch(REPO + "/actions/workflows/check.yml/dispatches", {
      method: "POST",
      headers: {
        ...headers(env.GITHUB_TOKEN),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main" }),
    });
    console.log("dispatch", response.status);
  },
};

const REPO = "https://api.github.com/repos/ProjectJJU/CourtWatch";

function headers(token) {
  return {
    Authorization: "Bearer " + token,
    Accept: "application/vnd.github+json",
    "User-Agent": "court-watch",
  };
}

async function checkIsBusy(token) {
  const response = await fetch(
    REPO + "/actions/workflows/check.yml/runs?per_page=20",
    { headers: headers(token) }
  );
  if (!response.ok) {
    console.log("runs", response.status);
    return true;
  }
  const payload = await response.json();
  return (payload.workflow_runs || []).some((run) => run.status && run.status !== "completed");
}

export default {
  async scheduled(_event, env) {
    if (await checkIsBusy(env.GITHUB_TOKEN)) {
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

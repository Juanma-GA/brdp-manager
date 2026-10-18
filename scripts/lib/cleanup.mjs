// Deleting the projects a verify-* script created, for good.
//
// A project with a background job still running (an import, embeddings, an
// AI Extract) cannot be deleted: the backend answers 409
// project_has_running_job. A script that deletes right after starting such a
// job used to leave its project behind silently, and the next run found it
// (pending embeddings, extra "Same BRDP" candidates...). Here a 409 waits for
// the job and tries again; whatever still cannot be deleted is printed, never
// swallowed.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Deletes each project permanently. `request(path, init)` is the script's
 * authenticated fetch; it returns a Response. Waits up to `waitMs` per project
 * for a running job. Returns the ids it could not delete.
 */
export async function deleteProjectsForGood(request, ids, { waitMs = 120000, log = console.log } = {}) {
  const left = [];
  for (const id of ids.filter(Boolean)) {
    const until = Date.now() + waitMs;
    let last;
    for (;;) {
      let res;
      try {
        res = await request(`/api/projects/${id}?permanent=true`, { method: "DELETE" });
      } catch (err) {
        last = err.message;
        if (Date.now() > until) break;
        await sleep(1000);
        continue;
      }
      if (res.ok || res.status === 404) { last = ""; break; }
      last = `${res.status} ${await res.text().catch(() => "")}`;
      if (res.status !== 409 || Date.now() > until) break;
      await sleep(1000);
    }
    if (last) left.push({ id, reason: last });
  }
  for (const { id, reason } of left) log(`WARNING: project ${id} could not be deleted (${reason.slice(0, 200)}): delete it by hand.`);
  return left.map((l) => l.id);
}

/** Deletes for good every project the user can see whose name matches. */
export async function deleteProjectsNamed(request, matches, options) {
  const res = await request("/api/projects");
  if (!res.ok) throw new Error(`cannot list projects to clean up: ${res.status}`);
  const ids = (await res.json()).filter((p) => matches(p.name)).map((p) => p.id);
  return deleteProjectsForGood(request, ids, options);
}

/** A fetch against the API with an admin's access token. */
export async function adminRequest(api, email, password) {
  const res = await fetch(`${api}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status}`);
  const { access_token: token } = await res.json();
  return (path, init = {}) =>
    fetch(`${api}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init.headers || {}), Authorization: `Bearer ${token}` } });
}

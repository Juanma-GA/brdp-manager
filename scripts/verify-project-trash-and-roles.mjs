// Live verification for AACF 2, Parts 3, 4 and 5 (HR9), against the real
// app (Vite + FastAPI + Postgres), no AI.
//
//   (b) Delete a project from BRDP Projects: the dialog says it moves to
//       the Trash and still asks for the name; it leaves the list, appears
//       in Settings > Trash > Projects with its standard, BRDPs, who and
//       when; Restore brings it back with its BRDPs. A name now used by an
//       active project: the restore is refused and offered under another
//       name. Delete permanently asks for the name. Someone with the
//       project open when it is deleted gets "Project not found". A delete
//       refused for a running job says why.
//   (c) Removing a project role asks first, naming the person, the project
//       and the role; Cancel sends nothing.
//   Users: a deleted user leaves the list for "Deleted users"; creating one
//       with their email offers to restore them; Delete permanently asks.
//
//     node scripts/verify-project-trash-and-roles.mjs
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = process.env.PROMPT_EVAL_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.PROMPT_EVAL_PASSWORD || "AdminTest123!";
const SHOTS = process.env.SHOTS_DIR || "/tmp";

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`  ok  ${message}`);
  else {
    failures += 1;
    console.log(`  FAIL ${message}`);
  }
}

async function main() {
  const login = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  }).then((r) => r.json());
  const auth = { Authorization: `Bearer ${login.access_token}`, "Content-Type": "application/json" };
  const api = (path, init = {}) => fetch(`${API}${path}`, { headers: auth, ...init });
  const suffix = Math.random().toString(36).slice(2, 8);
  const projectName = `AACF2 trash ${suffix}`;
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: projectName, standard: "S1000D 4.2" }) }).then((r) => r.json());
  for (const id of ["BRDP-TRP-A", "BRDP-TRP-B"]) {
    await api(`/api/projects/${project.id}/brdps`, { method: "POST", body: JSON.stringify({ identifier: id, title: id }) });
  }
  const userEmail = `aacf2-user-${suffix}@example.com`;
  const created = await api("/api/users", { method: "POST", body: JSON.stringify({ email: userEmail, display_name: `Role Person ${suffix}` }) }).then((r) => r.json());
  await api(`/api/users/${created.id}/project-roles`, { method: "PUT", body: JSON.stringify({ project_id: project.id, role: "editor" }) });
  const cleanup = [project.id];

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  const openSection = async (title) => {
    const details = page.locator("details", { has: page.locator("summary", { hasText: title }) }).first();
    if (!(await details.evaluate((d) => d.open))) await details.locator("summary").click();
    return details;
  };

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");

    console.log("(b) Someone has the project open when it is deleted");
    const other = await context.newPage();
    await other.goto(`${BASE_URL}/projects/${project.id}/records`);
    await other.waitForSelector("tbody tr", { timeout: 10000 });

    console.log("(b) Delete from BRDP Projects");
    await page.goto(`${BASE_URL}/projects`);
    await page.waitForSelector("table");
    // A delete refused for a running job says why, in words.
    await page.route(`**/api/projects/${project.id}`, (route) =>
      route.request().method() === "DELETE"
        ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ detail: { code: "project_has_running_job", jobs: ["embeddings"], message: "x" } }) })
        : route.continue(),
    );
    await page.locator("tr", { hasText: projectName }).getByRole("button", { name: "Delete" }).click();
    const dialog = page.locator("[class*=modal]").filter({ hasText: "Delete project" }).last();
    await page.getByText(/move to the Trash/).waitFor({ timeout: 20000 });
    const dialogText = await dialog.textContent();
    assert(/The project and its 2 BRDPs move to the Trash \(Settings\)/.test(dialogText), "the dialog says it moves to the Trash with its BRDPs");
    assert(/can restore it/.test(dialogText), "and that it can be restored");
    const confirm = page.getByRole("button", { name: "Move to the Trash" });
    assert(await confirm.isDisabled(), "it still asks for the name");
    await page.getByPlaceholder("Project name").fill(projectName);
    await confirm.click();
    await page.getByText(/background job is running on it \(embeddings\)/).waitFor({ timeout: 20000 });
    assert(true, 'a running job: "…a background job is running on it (embeddings)…"');
    await page.unroute(`**/api/projects/${project.id}`);
    await confirm.click();
    await page.locator("tr", { hasText: projectName }).waitFor({ state: "detached", timeout: 20000 });
    assert(true, "it leaves the project list");

    await other.locator("tbody tr").first().click();
    await other.getByTestId("records-field-title").fill("changed after delete");
    await other.getByTestId("records-field-title").blur();
    await other.getByTestId("records-unsaved-title").waitFor({ timeout: 20000 });
    const notFound = await other.getByTestId("records-unsaved-title").textContent();
    assert(/Project not found: it does not exist or has been moved to the Trash/.test(notFound), `the open page: "Project not found" (${notFound.slice(0, 90)})`);
    await other.close();

    console.log("(b) Settings > Trash > Projects");
    await page.goto(`${BASE_URL}/settings`);
    const trash = await openSection("Trash");
    const row = trash.getByTestId("trash-project-row").filter({ hasText: projectName });
    await row.waitFor({ timeout: 20000 });
    const rowText = await row.textContent();
    assert(rowText.includes("S1000D 4.2") && rowText.includes(ADMIN_EMAIL), "name, standard and who deleted it");
    assert((await row.locator("td").nth(2).textContent()) === "2", "its 2 BRDPs");
    await page.screenshot({ path: `${SHOTS}/trash-projects.png` });

    // A name now used by an active project: refused, offered another name.
    const clash = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: projectName, standard: "S1000D 4.2" }) }).then((r) => r.json());
    cleanup.push(clash.id);
    await row.getByTestId("trash-project-restore").click();
    await row.getByTestId("trash-project-rename").waitFor({ timeout: 20000 });
    assert(/An active project is already called/.test(await row.getByTestId("trash-project-rename").textContent()), "restore refused: the name is taken, another name offered");
    await row.getByTestId("trash-project-new-name").fill(`${projectName} restored`);
    await row.getByTestId("trash-project-restore-renamed").click();
    await row.waitFor({ state: "detached", timeout: 20000 });
    const brdps = await api(`/api/projects/${project.id}/brdps`).then((r) => r.json());
    assert(brdps.length === 2, "restored with its BRDPs");
    await page.goto(`${BASE_URL}/projects`);
    await page.locator("tr", { hasText: `${projectName} restored` }).waitFor({ timeout: 20000 });
    assert(true, "back in the project list, under the new name");

    // Delete permanently asks for the name.
    await api(`/api/projects/${clash.id}`, { method: "DELETE" });
    await page.goto(`${BASE_URL}/settings`);
    const trash2 = await openSection("Trash");
    const clashRow = trash2.getByTestId("trash-project-row").filter({ hasText: projectName }).first();
    await clashRow.getByTestId("trash-project-delete").click();
    const permanent = page.getByRole("button", { name: "Delete permanently", exact: true }).last();
    assert(await permanent.isDisabled(), "Delete permanently waits for the name");
    await page.getByPlaceholder("Project name").fill(projectName);
    await permanent.click();
    await clashRow.waitFor({ state: "detached", timeout: 20000 });
    assert((await api(`/api/trash/projects`).then((r) => r.json())).every((p) => p.id !== clash.id), "deleted permanently");

    console.log("(c) Removing a role asks first");
    const users = await openSection("User Management");
    const activeRow = () => users.locator("tr:not([data-testid=deleted-user-row])", { hasText: userEmail });
    const userRow = activeRow();
    let deletes = 0;
    page.on("request", (req) => {
      if (req.method() === "DELETE" && req.url().includes("/project-roles/")) deletes += 1;
    });
    let dialogMessage = "";
    page.once("dialog", (d) => {
      dialogMessage = d.message();
      d.dismiss();
    });
    await userRow.getByTestId("remove-role").click();
    await page.waitForTimeout(500);
    assert(dialogMessage.includes(`Role Person ${suffix}`) && dialogMessage.includes(userEmail), `names the person (${dialogMessage})`);
    // AACF 3: the role is shown translated ("Editor"), never the raw token.
    assert(dialogMessage.includes(`${projectName} restored`) && /the Editor role/.test(dialogMessage), "the project and the role (translated)");
    assert(deletes === 0, "Cancel: nothing sent to the server");
    assert((await userRow.getByTestId("remove-role").count()) === 1, "the role is still there");
    page.once("dialog", (d) => d.accept());
    await userRow.getByTestId("remove-role").click();
    await userRow.getByTestId("remove-role").waitFor({ state: "detached", timeout: 20000 });
    assert(deletes === 1, "Accept: the role is removed");

    console.log("Users: deleted users, the same email, delete permanently");
    page.once("dialog", (d) => d.accept());
    await userRow.getByRole("button", { name: "Delete", exact: true }).click();
    await userRow.waitFor({ state: "detached", timeout: 20000 });
    const deletedRow = users.getByTestId("deleted-user-row").filter({ hasText: userEmail });
    await deletedRow.waitFor({ timeout: 20000 });
    assert(true, "the deleted user is in Deleted users");
    const relogin = await fetch(`${API}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: userEmail, password: created.temporary_password }) });
    assert(relogin.status === 401, "and cannot log in");
    const form = users.locator("form").first();
    await form.locator('input[type="email"]').fill(userEmail);
    await form.locator("input").nth(1).fill("Again");
    await form.getByRole("button", { name: "Create user" }).click();
    await users.getByTestId("deleted-user-conflict").waitFor({ timeout: 20000 });
    assert(/A deleted user already has the email/.test(await users.getByTestId("deleted-user-conflict").textContent()), "the same email: offered to restore");
    await page.screenshot({ path: `${SHOTS}/deleted-user-conflict.png` });
    await users.getByTestId("deleted-user-conflict-restore").click();
    await activeRow().waitFor({ timeout: 20000 });
    assert((await users.getByTestId("deleted-user-row").filter({ hasText: userEmail }).count()) === 0, "restored: back in the list");
    page.once("dialog", (d) => d.accept());
    await activeRow().getByRole("button", { name: "Delete", exact: true }).click();
    await deletedRow.waitFor({ timeout: 20000 });
    await deletedRow.getByTestId("deleted-user-delete").click();
    await page.getByTestId("deleted-user-confirm-delete").click();
    await deletedRow.waitFor({ state: "detached", timeout: 20000 });
    assert((await api("/api/users/deleted").then((r) => r.json())).every((u) => u.email !== userEmail), "deleted permanently, after an explicit confirmation");

    console.log("Spanish");
    await page.locator("header select, nav select").first().selectOption("es");
    const trashEs = await openSection("Papelera");
    assert((await trashEs.textContent()).includes("Proyectos"), 'the Trash has its "Proyectos" section');
    await page.locator("header select, nav select").first().selectOption("en");
  } finally {
    await browser.close();
    for (const id of cleanup) await api(`/api/projects/${id}?permanent=true`, { method: "DELETE" });
    const leftover = await api("/api/users/deleted").then((r) => r.json());
    for (const u of leftover.filter((x) => x.email === userEmail)) await api(`/api/users/${u.id}/permanent`, { method: "DELETE" });
  }
  console.log(failures ? `\n${failures} FAILED` : "\nALL OK");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Drive the web app through the capture journey in a real browser and save
// screenshots: log in, cookbook, upload a PDF, review the draft, edit its
// title, confirm, open the saved recipe, reload it. This is how the web
// images under docs/images/ were taken, and it is the only check that renders
// the pages (the vitest suite runs without a DOM). Scope: a smoke check that
// every page loads with real content and that one edit survives confirm and
// reload. It is not a substitute for the unit tests.
//
// Run by hand, not in CI. Playwright is not a dependency of this repository:
// point NODE_PATH at an installation that has it. Tested with Playwright
// 1.60.0 and the Chromium it installs (`npx playwright install chromium`
// in that installation if the browser is missing).
//
//   make demo && (API on :8000 with .env.demo, web on :3000, see README)
//   NODE_PATH=/path/to/node_modules node scripts/web-journey.mjs <out-dir> [pdf]
//
// Optional PLAYWRIGHT_CHROMIUM_EXECUTABLE selects an installed Chromium binary.
// Also verifies multi-page rejection, empty-step save blocking, local reset,
// and cookbook search retrieval. Uses loopback URLs only; writes demo records.
// Exits non-zero if a page fails to load its content, if the browser reports
// a page error, or if the edited title does not come back after reload.
import { createRequire } from "node:module";
import path from "node:path";
import { mkdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = process.env.WEB_BASE_URL ?? "http://localhost:3000";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(BASE).hostname)) throw new Error("This journey writes demo data: use a loopback URL only.");
const EMAIL = process.env.DEMO_EMAIL ?? "demo@tastelog.local";
const PASSWORD = process.env.DEMO_PASSWORD ?? "demo-password";
const [outDir, pdfArg] = process.argv.slice(2);
if (!outDir) {
  console.error("usage: node scripts/web-journey.mjs <out-dir> [pdf]");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const pdf = pdfArg ?? path.resolve("tests/eval/fidelity/inputs/avocado_salad.pdf");
const shot = (page, name) => page.screenshot({ path: path.join(outDir, `${name}.png`) });

const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
try {
  console.log("browser:", browser.version(), "playwright:", require("playwright/package.json").version);
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const assertNoPageErrors = (step) => {
    if (pageErrors.length) throw new Error(`page error during ${step}: ${pageErrors.join(" | ")}`);
  };

  await page.goto(`${BASE}/add`, { waitUntil: "networkidle" });
  if (new URL(page.url()).pathname !== "/login") throw new Error("Unauthenticated capture page was not gated");
  // Prefetch/RSC requests must obey the same auth gate.
  const prefetch = await context.request.get(`${BASE}/add?_rsc=auth-check`, {
    headers: { RSC: "1", "Next-Router-Prefetch": "1" }, maxRedirects: 0,
  });
  if (prefetch.status() !== 307 || !prefetch.headers().location?.includes("/login")) throw new Error("Unauthenticated prefetch bypassed login");
  const unauthorized = await context.request.get(`${BASE}/api/recipes`);
  if (unauthorized.status() !== 401) throw new Error("API rewrite did not preserve backend auth");
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
  if (!(await context.cookies()).some(cookie => cookie.name.includes("auth-token"))) throw new Error("Login did not create a server-readable session cookie");
  // The cookbook has rendered only once a recipe link (or the empty state) is up.
  await page
    .locator('a[href^="/recipes/"]')
    .or(page.getByText("No recipes yet.", { exact: true }))
    .first()
    .waitFor({ timeout: 30_000 });
  assertNoPageErrors("login/cookbook");
  await shot(page, "web-cookbook");
  console.log("logged in:", page.url(), "recipes:", await page.locator('a[href^="/recipes/"]').count());

  await page.goto(`${BASE}/add`, { waitUntil: "networkidle" });
  // Refuse a multi-page source clearly before testing the happy path.
  await page.setInputFiles('input[type="file"]', path.resolve("tests/eval/fidelity/inputs/french_onion_soup.pdf"));
  await page.click('button:has-text("Parse Recipe")');
  await page.getByRole("alert").filter({ hasText: "Multi-page PDFs" }).waitFor();
  if (!new URL(page.url()).pathname.startsWith("/add")) throw new Error("Unsupported PDF created a draft");
  await page.setInputFiles('input[type="file"]', pdf);
  await shot(page, "web-capture");
  await page.click('button:has-text("Parse Recipe")');
  await page.waitForURL((u) => u.pathname.startsWith("/review/"), { timeout: 60_000 });
  // The form is rendered only once the draft has loaded; a missing confirm
  // button means the page failed (for example a draft fetch that errored).
  await page.waitForSelector('button:has-text("Save recipe")', { timeout: 30_000 });
  assertNoPageErrors("review");
  if (await page.getByText("Raw draft (debug)").count()) throw new Error("Debug output visible");
  await page.getByText(/Check ingredients and instructions against the source/).waitFor();
  // Emptying the last section must block saving; reset restores it without capture.
  const instructions = page.getByRole("textbox", { name: /^Instruction / });
  const originalSteps = await instructions.count();
  for (let i = 0; i < originalSteps; i++) await instructions.nth(i).fill(" ");
  if (!(await page.getByRole("button", { name: "Save recipe", exact: true }).isDisabled())) throw new Error("Empty instructions can save");
  let captureRequests = 0;
  page.on("request", request => { if (request.method() === "POST" && request.url().includes("/drafts/capture")) captureRequests++; });
  await page.getByRole("button", { name: "Reset edits", exact: true }).click();
  if ((await instructions.first().inputValue()).trim() === "") throw new Error("Reset did not restore instructions");
  if (captureRequests) throw new Error("Reset unexpectedly reran extraction");
  console.log("review:", page.url());

  // Edit the title, confirm, and check the edit on the saved recipe and after a reload.
  const titleInput = page.getByRole("textbox", { name: "Recipe title", exact: true });
  const editedTitle = "My weeknight crepes";
  await titleInput.fill(editedTitle);
  await shot(page, "web-review");
  await page.click('button:has-text("Save recipe")');
  await page.waitForURL((u) => u.pathname.startsWith("/recipes/"), { timeout: 60_000 });
  await page.getByText(editedTitle, { exact: true }).first().waitFor({ timeout: 30_000 });
  assertNoPageErrors("confirm/recipe");
  await shot(page, "web-recipe");
  console.log("recipe:", page.url(), "title:", editedTitle);

  const savedRecipePath = new URL(page.url()).pathname;
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText(editedTitle, { exact: true }).first().waitFor({ timeout: 30_000 });
  assertNoPageErrors("reload");
  console.log("reload ok: edited title persisted");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.getByPlaceholder(/Search recipes/).fill("weeknight crepes");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const savedLink = page.locator(`a[href="${savedRecipePath}"]`);
  await savedLink.waitFor({ timeout: 30000 });
  await shot(page, "web-retrieval");
  await savedLink.click();
  await page.getByText(editedTitle, { exact: true }).first().waitFor();
  assertNoPageErrors("retrieval");
  console.log("retrieval ok: saved recipe reopened from cookbook");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.waitForURL((u) => u.pathname === "/login");
  await page.goto(`${BASE}/add`, { waitUntil: "networkidle" });
  if (new URL(page.url()).pathname !== "/login") throw new Error("Sign-out left protected pages accessible");
  console.log("auth ok: signed-out page, prefetch and API requests denied; cookie login and logout verified");
} finally {
  await browser.close();
}

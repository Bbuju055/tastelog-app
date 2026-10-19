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
// Exits non-zero if a page fails to load its content, if the browser reports
// a page error, or if the edited title does not come back after reload.
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = process.env.WEB_BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.DEMO_EMAIL ?? "demo@tastelog.local";
const PASSWORD = process.env.DEMO_PASSWORD ?? "demo-password";
const [outDir, pdfArg] = process.argv.slice(2);
if (!outDir) {
  console.error("usage: node scripts/web-journey.mjs <out-dir> [pdf]");
  process.exit(2);
}
const pdf = pdfArg ?? path.resolve("tests/eval/fidelity/inputs/avocado_salad.pdf");
const shot = (page, name) => page.screenshot({ path: path.join(outDir, `${name}.png`) });

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const assertNoPageErrors = (step) => {
    if (pageErrors.length) throw new Error(`page error during ${step}: ${pageErrors.join(" | ")}`);
  };

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
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
  await page.setInputFiles('input[type="file"]', pdf);
  await shot(page, "web-capture");
  await page.click('button:has-text("Parse Recipe")');
  await page.waitForURL((u) => u.pathname.startsWith("/review/"), { timeout: 60_000 });
  // The form is rendered only once the draft has loaded; a missing confirm
  // button means the page failed (for example a draft fetch that errored).
  await page.waitForSelector('button:has-text("Looks Good")', { timeout: 30_000 });
  assertNoPageErrors("review");
  await shot(page, "web-review");
  console.log("review:", page.url());

  // Edit the title, confirm, and check the edit on the saved recipe and after a reload.
  const titleInput = page.locator('input:not([type="file"]):not([type="checkbox"])').first();
  const originalTitle = await titleInput.inputValue();
  const editedTitle = `${originalTitle} (edited)`;
  await titleInput.fill(editedTitle);
  await page.click('button:has-text("Looks Good")');
  await page.waitForURL((u) => u.pathname.startsWith("/recipes/"), { timeout: 60_000 });
  await page.getByText(editedTitle, { exact: true }).first().waitFor({ timeout: 30_000 });
  assertNoPageErrors("confirm/recipe");
  await shot(page, "web-recipe");
  console.log("recipe:", page.url(), "title:", editedTitle);

  await page.reload({ waitUntil: "networkidle" });
  await page.getByText(editedTitle, { exact: true }).first().waitFor({ timeout: 30_000 });
  assertNoPageErrors("reload");
  console.log("reload ok: edited title persisted");
} finally {
  await browser.close();
}

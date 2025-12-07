// server.js
// Walla "sales (cash basis)" export scraper

import express from "express";
import cors from "cors";
import { chromium, devices } from "playwright";

process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] UnhandledPromiseRejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[FATAL] UncaughtException:", err);
});

// Create app
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ----------------------------------------
// Basic request logger
// ----------------------------------------
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});

// ----------------------------------------
// Healthcheck
// ----------------------------------------
app.get("/healthz", (_req, res) => {
  res.send("ok");
});

// ----------------------------------------
// Optional API-key auth (SCRAPER_TOKEN)
// ----------------------------------------
app.use((req, res, next) => {
  const AUTH_TOKEN = process.env.SCRAPER_TOKEN || "";
  if (!AUTH_TOKEN) return next(); // auth disabled if no token set

  const token = req.get("x-api-key") || req.query.key;
  if (token === AUTH_TOKEN) return next();

  return res.status(401).json({ ok: false, error: "unauthorized" });
});

// ----------------------------------------
// Helpers
// ----------------------------------------
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", (err) => reject(err));
  });
}

async function withBrowser(fn, opts = {}) {
  const dpr = Math.max(1, Math.min(4, Number(opts.dpr) || 2));

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  });

  try {
    const context = await browser.newContext({
      ...devices["Desktop Chrome"],
      deviceScaleFactor: dpr,
      ignoreHTTPSErrors: true,
      locale: "en-US",
      timezoneId: "America/New_York",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });

    context.setDefaultNavigationTimeout(120000);
    context.setDefaultTimeout(90000);

    await context.addInitScript(() => {
      try {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
      } catch {
        // ignore
      }
    });

    const page = await context.newPage();
    await page.setViewportSize({ width: 1360, height: 1800 });

    return await fn({ browser, context, page });
  } finally {
    await browser.close();
  }
}

// ----------------------------------------
// Login helper – logs in on the *current* page
// ----------------------------------------
async function loginOnCurrentPage(page, username, password) {
  console.log("[LOGIN] Attempting login on URL:", page.url());

  // Email: still safe to use label
  const emailInput = page.getByLabel(/email/i).first();
  await emailInput.waitFor({ state: "visible", timeout: 20000 });

  // Password: target only the actual input, not the "show password" button
  const passwordInput = page
    .locator("input[type='password'], input[name='password'], input#password")
    .first();

  await passwordInput.waitFor({ state: "visible", timeout: 20000 });

  await emailInput.fill(username);
  await passwordInput.fill(password);

  const loginButton = page
    .getByRole("button", { name: /log in|login|sign in/i })
    .first();

  await loginButton.waitFor({ state: "visible", timeout: 15000 });

  await Promise.all([
    page.waitForURL((url) => !url.pathname.includes("/login"), {
      timeout: 30000,
    }),
    loginButton.click(),
  ]);

  console.log("[LOGIN] Clicked login button, current URL:", page.url());
}

function isLoginPageUrl(urlString) {
  try {
    return new URL(urlString).pathname.includes("/login");
  } catch {
    return false;
  }
}

// ----------------------------------------
// Walla Sales Export Route (cash basis)
// ----------------------------------------
// GET /export-walla-sales?start=YYYY-MM-DD&end=YYYY-MM-DD
// Optional: ?webhook=https://... to POST the file somewhere
// ----------------------------------------
app.get("/export-walla-sales", async (req, res) => {
  const { start, end, webhook } = req.query;

  if (!start || !end) {
    return res.status(400).json({
      ok: false,
      error: "missing_params",
      details: "Query params 'start' and 'end' are required (YYYY-MM-DD).",
    });
  }

  const username = process.env.WALLA_USER || req.query.user;
  const password = process.env.WALLA_PASS || req.query.pass;

  if (!username || !password) {
    return res.status(400).json({
      ok: false,
      error: "missing_credentials",
      details: "Set WALLA_USER and WALLA_PASS env vars or pass ?user=&pass=.",
    });
  }

  try {
    const result = await withBrowser(async ({ page }) => {
      // 1) Build SALES report URL with your params + dynamic dates
      const reportUrl = new URL(
        "https://manage.hellowalla.com/the-pearl/reports/sales"
      );

      reportUrl.searchParams.set("basis", "cash");
      reportUrl.searchParams.set("cashViewBy", "paid-date");
      reportUrl.searchParams.set("virtualDisplay", "by-location");
      reportUrl.searchParams.set("locationId", "all");
      reportUrl.searchParams.set("timeFrameId", "custom");
      reportUrl.searchParams.set("startDate", String(start));
      reportUrl.searchParams.set("endDate", String(end));
      reportUrl.searchParams.set("page", "1");
      reportUrl.searchParams.set("pageSize", "1000");
      reportUrl.searchParams.set("sort", "date");
      reportUrl.searchParams.set("sortDir", "desc");
      reportUrl.searchParams.set("reportCashCategory", "all");
      reportUrl.searchParams.set("paymentMethod", "all");

      const reportUrlStr = reportUrl.toString();

      // 2) Explicit login URL with redirect back to SALES report
      const loginUrl = `https://manage.hellowalla.com/login?redirectUrl=${encodeURIComponent(
        reportUrlStr
      )}&bizId=2657&bizName=The+Pearl`;

      console.log("[SALES] Navigating to login URL:", loginUrl);
      await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
      console.log("[SALES] After initial goto, URL:", page.url());

      // 3) Login if needed
      if (isLoginPageUrl(page.url())) {
        console.log("[SALES] Detected login, performing login...");
        await loginOnCurrentPage(page, username, password);

        try {
          await page.waitForURL(
            (url) =>
              !url.pathname.includes("/login") &&
              url.href.includes("/reports/sales"),
            { timeout: 30000 }
          );
        } catch {
          console.log(
            "[SALES] Login done but did not reach sales report; going there explicitly..."
          );
          await page.goto(reportUrlStr, { waitUntil: "domcontentloaded" });
        }
      }

      console.log("[SALES] Post-login URL:", page.url());

      if (isLoginPageUrl(page.url())) {
        throw new Error(
          `Still on login page after attempted login. Current URL: ${page.url()}`
        );
      }

      // Let React render
      await page.waitForTimeout(3000);

      // 4) Find Export button
      const exportLocator = page.getByText(/^\s*export\s*$/i).first();

      try {
        await exportLocator.waitFor({ state: "visible", timeout: 60000 });
      } catch (err) {
        throw new Error(
          `Export button not found – likely no data in this date range. Current URL: ${page.url()} | Inner error: ${err}`
        );
      }

      console.log("[SALES] Found Export button, clicking...");

      // 5) Click Export & capture download
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 180000 }),
        exportLocator.click({ force: true }),
      ]);

      const fileName = download.suggestedFilename();
      const mimeType =
        (typeof download.mimeType === "function"
          ? download.mimeType()
          : null) || "application/octet-stream";

      const stream = await download.createReadStream();
      if (!stream) {
        throw new Error("Could not create download stream");
      }

      const buffer = await streamToBuffer(stream);
      const fileBase64 = buffer.toString("base64");

      console.log("[SALES] Download complete:", fileName, mimeType);

      return { fileName, mimeType, fileBase64 };
    });

    // Optional: send to webhook
    let webhookResult = null;
    if (webhook) {
      try {
        const resp = await fetch(webhook, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            fileName: result.fileName,
            mimeType: result.mimeType,
            fileBase64: result.fileBase64,
          }),
        });
        webhookResult = { ok: resp.ok, status: resp.status };
      } catch (err) {
        webhookResult = { ok: false, error: String(err) };
      }
    }

    return res.json({
      ok: true,
      fileName: result.fileName,
      mimeType: result.mimeType,
      fileBase64: result.fileBase64,
      webhookResult,
    });
  } catch (err) {
    console.error("Walla SALES export failed:", err);
    return res.status(500).json({
      ok: false,
      error: "export_failed",
      details: String(err),
    });
  }
});

// ----------------------------------------
// Start server
// ----------------------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`walla-transactions scraper listening on port ${PORT}`);
});

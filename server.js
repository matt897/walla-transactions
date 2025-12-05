// server.js
// Walla "first purchase" export scraper

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
// Basic request logger (optional but handy)
// ----------------------------------------
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});

// ----------------------------------------
// Healthcheck (must always respond)
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
      viewport: { width: 1360, height: 1800 },
    });

    await context.addInitScript(() => {
      try {
        window.scrollTo(0, 0);
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
// Login helper – logs in on the *current* page using accessible labels
// ----------------------------------------
async function loginOnCurrentPage(page, username, password) {
  console.log("[LOGIN] Attempting login on URL:", page.url());

  const emailInput = page.getByLabel(/email/i).first();
  const passwordInput = page.getByLabel(/password/i).first();
  const loginButton = page
    .locator(
      [
        "button:has-text('Log in')",
        "button:has-text('Sign in')",
        "button:has-text('Login')",
        "[type='submit']",
      ].join(", ")
    )
    .first();

  await Promise.all([
    emailInput.waitFor({ state: "visible", timeout: 15000 }),
    passwordInput.waitFor({ state: "visible", timeout: 15000 }),
  ]);

  await emailInput.fill(username);
  await passwordInput.fill(password);
  await loginButton.waitFor({ state: "visible", timeout: 15000 });

  await Promise.all([
    page.waitForURL((url) => !url.pathname.includes("/login"), {
      timeout: 30000,
    }),
    loginButton.click(),
  ]);

  console.log("[LOGIN] Clicked login button, current URL:", page.url());
}

// ----------------------------------------
// Walla First-Purchase Export Route
// ----------------------------------------
// GET /export-walla-first-purchase?start=YYYY-MM-DD&end=YYYY-MM-DD
// Optional: ?webhook=https://... to POST the file somewhere
// ----------------------------------------
const isLoginPage = (url) => {
  try {
    return new URL(url).pathname.includes("/login");
  } catch {
    return false;
  }
};

const isReportPage = (url) => {
  try {
    return new URL(url).pathname.includes("/reports/first-purchase");
  } catch {
    return false;
  }
};

app.get("/export-walla-first-purchase", async (req, res) => {
  console.log("[EXPORT] Incoming request:", req.query);

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
    console.log("[EXPORT] Launching browser...");

    const result = await withBrowser(async ({ page }) => {
      // 1) Build first-purchase report URL with dates
      const reportUrl = new URL(
        "https://manage.hellowalla.com/the-pearl/reports/first-purchase"
      );
      reportUrl.searchParams.set("offeringId", "all");
      reportUrl.searchParams.set("locationId", "all");
      reportUrl.searchParams.set("timeFrameId", "custom");
      reportUrl.searchParams.set("startDate", String(start));
      reportUrl.searchParams.set("endDate", String(end));
      reportUrl.searchParams.set("groupBy", "week");

      const reportUrlStr = reportUrl.toString();

      // 2) Navigate explicitly to login with redirect to report
      const loginUrl = `https://manage.hellowalla.com/login?redirectUrl=${encodeURIComponent(
        reportUrlStr
      )}&bizId=2657&bizName=The+Pearl`;

      console.log("[EXPORT] Navigating to login URL:", loginUrl);
      await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
      console.log("[EXPORT] After initial goto, URL:", page.url());

      if (isLoginPage(page.url())) {
        console.log("[EXPORT] Detected login page, performing login...");
        await loginOnCurrentPage(page, username, password);

        try {
          await page.waitForURL(
            (url) =>
              !url.pathname.includes("/login") &&
              url.href.includes("/reports/first-purchase"),
            { timeout: 30000 }
          );
        } catch {
          console.log(
            "[EXPORT] Login done but did not reach report; going there explicitly..."
          );
          await page.goto(reportUrlStr, { waitUntil: "domcontentloaded" });
        }
      }

      console.log("[EXPORT] Post-login URL:", page.url());
      if (isLoginPage(page.url())) {
        throw new Error(
          `Still on login page after attempted login. Current URL: ${page.url()}`
        );
      }

      if (!isReportPage(page.url())) {
        console.log("[EXPORT] Navigating to report URL after login...");
        await page.goto(reportUrlStr, { waitUntil: "domcontentloaded" });
      }

      if (isLoginPage(page.url())) {
        throw new Error(
          `Unexpected redirect back to login after navigation. Current URL: ${page.url()}`
        );
      }

      await page.waitForTimeout(3000); // let React render

      // 3) Find Export button
      let exportLocator = page.getByRole("button", { name: /export/i }).first();

      try {
        await exportLocator.waitFor({ state: "visible", timeout: 45000 });
      } catch (err) {
        console.log("[EXPORT] Export button role locator failed, retrying by text...");
        exportLocator = page.getByText(/^\s*export\s*$/i).first();
        await exportLocator.waitFor({ state: "visible", timeout: 15000 });
      }

      console.log("[EXPORT] Found Export button, clicking...");

      // 4) Click Export & capture the download
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 120000 }),
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

      console.log("[EXPORT] Download complete:", fileName, mimeType);

      return { fileName, mimeType, fileBase64 };
    });

    console.log("[EXPORT] Browser run finished, preparing response...");

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
    console.error("[EXPORT] Walla export failed:", err);
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

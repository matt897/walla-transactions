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

  const emailCandidates = [
    'input[type="email"]',
    'input[name*="email" i]',
    'input[id*="email" i]',
    'input[placeholder*="email" i]',
    'input[type="text"][name*="email" i]',
    'input[type="text"][id*="email" i]',
    'input[type="text"][name*="user" i]',
    'input[type="text"][id*="user" i]',
  ];

  let emailInput = null;
  for (const sel of emailCandidates) {
    emailInput = await page.$(sel);
    if (emailInput) {
      console.log("[LOGIN] Found email input via selector:", sel);
      break;
    }
  }
  if (!emailInput) {
    throw new Error("Email/username input not found on login page");
  }

  const passwordCandidates = [
    'input[type="password"]',
    'input[name*="pass" i]',
    'input[id*="pass" i]',
    'input[autocomplete="current-password"]',
  ];

  let passwordInput = null;
  for (const sel of passwordCandidates) {
    passwordInput = await page.$(sel);
    if (passwordInput) {
      console.log("[LOGIN] Found password input via selector:", sel);
      break;
    }
  }
  if (!passwordInput) {
    throw new Error("Password input not found on login page");
  }

  await emailInput.fill(username);
  await passwordInput.fill(password);

  const loginButtonCandidates = [
    'button:has-text("Log in")',
    'button:has-text("Login")',
    'button:has-text("Sign in")',
    'button:has-text("Sign In")',
    'button[type="submit"]',
    'input[type="submit"]',
  ];

  let loginButton = null;
  for (const sel of loginButtonCandidates) {
    loginButton = await page.$(sel);
    if (loginButton) {
      console.log("[LOGIN] Found login button via selector:", sel);
      break;
    }
  }
  if (!loginButton) {
    throw new Error("Login button not found on login page");
  }

  await Promise.all([
    page.waitForNavigation({ timeout: 30000, waitUntil: "domcontentloaded" }).catch(() => {}),
    loginButton.click({ force: true }),
  ]);

  console.log("[LOGIN] Clicked login button, current URL:", page.url());
}

// ----------------------------------------
// Walla First-Purchase Export Route
// ----------------------------------------
// GET /export-walla-first-purchase?start=YYYY-MM-DD&end=YYYY-MM-DD
// Optional: ?webhook=https://... to POST the file somewhere
// ----------------------------------------
app.get("/export-walla-first-purchase", async (req, res) => {
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
      //
      // 1) Build first-purchase report URL with dates
      //    We go there *first*, Walla will redirect to /login?redirectUrl=...
      //
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
      console.log("[EXPORT] Navigating to report URL:", reportUrlStr);

      await page.goto(reportUrlStr, { waitUntil: "domcontentloaded" });
      console.log("[EXPORT] After initial goto, URL:", page.url());

      //
      // 2) If we got redirected to login, perform login there
      //
      if (page.url().includes("/login")) {
        console.log("[EXPORT] Detected login redirect, performing login...");
        await loginOnCurrentPage(page, username, password);

        // After login, Walla should send us to redirectUrl (the report)
        try {
          await page.waitForURL(
            (url) =>
              !url.pathname.includes("/login") &&
              url.href.includes("/reports/first-purchase"),
            { timeout: 30000 }
          );
        } catch {
          // Fallback: just go to the report URL again now that we're logged in
          console.log("[EXPORT] Login done but did not reach report; going there explicitly...");
          await page.goto(reportUrlStr, { waitUntil: "domcontentloaded" });
        }
      }

      console.log("[EXPORT] Post-login URL:", page.url());
      await page.waitForTimeout(3000); // let React render

      //
      // 3) Find Export button
      //
      const exportLocator =
        (await page.$('button:has-text("Export")')) ||
        (await page.$('div:has-text("Export")')) ||
        (await page.$('text=Export'));

      if (!exportLocator) {
        throw new Error(
          `Export button not found on report page. Current URL: ${page.url()}`
        );
      }

      console.log("[EXPORT] Found Export button, clicking...");

      //
      // 4) Click Export & capture the download
      //
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
    console.error("Walla export failed:", err);
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

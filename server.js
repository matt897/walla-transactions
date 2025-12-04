// server.js
// Walla "first purchase" export scraper – ES module

import express from "express";
import cors from "cors";
import { chromium, devices } from "playwright";
import { Readable } from "stream";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ----------------------------------------
// Simple healthcheck
// ----------------------------------------
app.get("/healthz", (_req, res) => res.send("ok"));

// ----------------------------------------
// Optional API-key auth (SCRAPER_TOKEN)
// ----------------------------------------
app.use((req, res, next) => {
  const AUTH_TOKEN = process.env.SCRAPER_TOKEN || "";
  if (!AUTH_TOKEN) return next(); // auth disabled if no token set

  const token = req.get("x-api-key") || req.query.key;
  if (token === AUTH_TOKEN) return next();

  return res.status(401).json({ error: "unauthorized" });
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
      // 1) Login page
      await page.goto("https://manage.hellowalla.com/login", {
        waitUntil: "domcontentloaded",
      });

      const emailSelector = [
        'input[type="email"]',
        'input[name="email"]',
        'input[autocomplete="email"]',
        'input[id*="email" i]',
      ].join(", ");

      const passwordSelector = [
        'input[type="password"]',
        'input[name="password"]',
        'input[autocomplete="current-password"]',
        'input[id*="password" i]',
      ].join(", ");

      await page.waitForSelector(emailSelector, { timeout: 20000 });
      await page.waitForSelector(passwordSelector, { timeout: 20000 });

      await page.fill(emailSelector, username);
      await page.fill(passwordSelector, password);

      const loginButton =
        (await page.$('button:has-text("Log in")')) ||
        (await page.$('button:has-text("Login")')) ||
        (await page.$('button[type="submit"]')) ||
        (await page.$('input[type="submit"]'));

      if (!loginButton) {
        throw new Error("Walla login button not found");
      }

      await Promise.all([
        page.waitForLoadState("networkidle"),
        loginButton.click({ force: true }),
      ]);

      // 2) Build first-purchase report URL with dates
      const reportUrl = new URL(
        "https://manage.hellowalla.com/the-pearl/reports/first-purchase"
      );
      reportUrl.searchParams.set("offeringId", "all");
      reportUrl.searchParams.set("locationId", "all");
      reportUrl.searchParams.set("timeFrameId", "custom");
      reportUrl.searchParams.set("startDate", String(start));
      reportUrl.searchParams.set("endDate", String(end));
      reportUrl.searchParams.set("groupBy", "week");

      await page.goto(reportUrl.toString(), {
        waitUntil: "networkidle",
      });

      await page.waitForTimeout(3000);

      // 3) Find & click Export
      const exportLocator =
        (await page.$('text=Export')) ||
        (await page.$('button:has-text("Export")')) ||
        (await page.$('div:has-text("Export")'));

      if (!exportLocator) {
        throw new Error("Export button not found on report page");
      }

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
  console.log(`walla-transcations scraper listening on port ${PORT}`);
});

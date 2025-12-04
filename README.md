# Walla Transactions Scraper

This service exposes an `/export-walla-first-purchase` endpoint that logs into Walla and downloads the first purchase report for a provided date range.

## Running locally

Install dependencies and start the server:

```bash
npm install
npm start
```

The server listens on port `8082` by default. You can override the port with the `PORT` environment variable:

```bash
PORT=9090 npm start
```

When running in Docker, port `8082` is exposed from the container to match the default listener.

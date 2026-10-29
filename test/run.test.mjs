import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { run } from "../src/index.mjs";

const dir = mkdtempSync(join(tmpdir(), "deploy-indexing-"));
const statePath = join(dir, "state.json");
const realFetch = globalThis.fetch;
const realLog = console.log;
let calls;
let sitemap;
let indexNowStatus;

const urlset = (n) =>
  `<?xml version="1.0"?><urlset>${Array.from({ length: n }, (_, i) => `<url><loc>https://example.com/p${i}</loc><lastmod>2026-10-01</lastmod></url>`).join("")}</urlset>`;

beforeEach(() => {
  calls = { indexnow: [], gsc: 0 };
  sitemap = urlset(5);
  indexNowStatus = 200;
  rmSync(statePath, { force: true });
  console.log = () => {};
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("https://example.com/sitemap.xml")) return new Response(sitemap, { status: 200 });
    if (u.startsWith("https://api.indexnow.org")) {
      calls.indexnow.push(JSON.parse(init.body).urlList);
      return new Response("", { status: indexNowStatus });
    }
    if (u.startsWith("https://www.googleapis.com")) {
      calls.gsc++;
      return new Response("{}", { status: 200 });
    }
    throw new Error(`unexpected ${u}`);
  };
});

after(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  rmSync(dir, { recursive: true, force: true });
});

const env = (extra = {}) => ({ DI_SITE_URL: "https://example.com", DI_INDEXNOW_KEY: "k", DI_STATE_PATH: statePath, ...extra });
const readState = () => JSON.parse(readFileSync(statePath, "utf8"));
const seed = (state) => writeFileSync(statePath, JSON.stringify(state));

test("URLs from a 429 batch are retried on the next run", async () => {
  seed({ urls: {}, gscSubmittedAt: null });
  indexNowStatus = 429;
  await run(env());
  assert.equal(calls.indexnow[0].length, 5);
  assert.deepEqual(readState().urls, {});
  assert.equal(readState().pending.length, 5);
  indexNowStatus = 200;
  await run(env());
  assert.equal(calls.indexnow[1].length, 5);
  assert.equal(Object.keys(readState().urls).length, 5);
  assert.deepEqual(readState().pending, []);
});

test("an HTML response keeps the saved state", async () => {
  const saved = { urls: { "https://example.com/a": "1" }, gscSubmittedAt: null };
  seed(saved);
  sitemap = "<!doctype html><html><body>App</body></html>";
  await run(env());
  assert.equal(calls.indexnow.length, 0);
  assert.deepEqual(readState(), saved);
});

test("an empty sitemap keeps a non-empty saved state", async () => {
  const saved = { urls: { "https://example.com/a": "1" }, gscSubmittedAt: null };
  seed(saved);
  sitemap = "<urlset></urlset>";
  await run(env());
  assert.equal(calls.indexnow.length, 0);
  assert.deepEqual(readState(), saved);
});

test("the GSC interval is read from saved state", async () => {
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  seed({ urls: {}, gscSubmittedAt: recent });
  await run(env({ DI_GOOGLE_ACCESS_TOKEN: "t", DI_GSC_MIN_INTERVAL_HOURS: "24" }));
  assert.equal(calls.gsc, 0);
  assert.equal(readState().gscSubmittedAt, recent);
  await run(env({ DI_GOOGLE_ACCESS_TOKEN: "t", DI_GSC_MIN_INTERVAL_HOURS: "0.5" }));
  assert.equal(calls.gsc, 1);
  assert.notEqual(readState().gscSubmittedAt, recent);
});

test("an empty DI_MAX_URLS defaults to 5000", async () => {
  seed({ urls: {}, gscSubmittedAt: null });
  sitemap = urlset(5001);
  await run(env({ DI_MAX_URLS: "" }));
  assert.equal(calls.indexnow[0].length, 5000);
  assert.equal(readState().pending.length, 1);
  assert.equal(Object.keys(readState().urls).length, 5000);
});

const mixed = () => {
  const recent = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const entries = Array.from({ length: 100 }, (_, i) => `<url><loc>https://example.com/u${i}</loc><lastmod>${i < 30 ? recent : "2026-01-01"}</lastmod></url>`);
  return `<urlset>${entries.join("")}</urlset>`;
};

test("a capped first run keeps old URLs as baseline and sends the rest of the window next run", async () => {
  sitemap = mixed();
  await run(env({ DI_MAX_URLS: "20" }));
  assert.equal(calls.indexnow[0].length, 20);
  const state = readState();
  assert.equal(Object.keys(state.urls).length, 90);
  assert.equal(state.urls["https://example.com/u99"], "2026-01-01");
  assert.equal(state.pending.length, 10);
  await run(env({ DI_MAX_URLS: "20" }));
  assert.equal(calls.indexnow[1].length, 10);
  assert.deepEqual(calls.indexnow[1].sort(), state.pending.sort());
  assert.equal(Object.keys(readState().urls).length, 100);
  await run(env({ DI_MAX_URLS: "20" }));
  assert.equal(calls.indexnow.length, 2);
});

test("a failed first run keeps old URLs as baseline and retries only the window", async () => {
  sitemap = mixed();
  indexNowStatus = 503;
  await run(env());
  assert.equal(calls.indexnow[0].length, 30);
  assert.equal(Object.keys(readState().urls).length, 70);
  indexNowStatus = 200;
  await run(env());
  assert.equal(calls.indexnow[1].length, 30);
  assert.equal(Object.keys(readState().urls).length, 100);
});

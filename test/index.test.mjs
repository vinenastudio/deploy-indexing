import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  batch,
  capUrls,
  collectUrls,
  decodeEntities,
  diffState,
  excludeUrls,
  filterHost,
  gscDue,
  isTruthy,
  nextUrlState,
  normalizeState,
  parseExclude,
  parseSitemap,
  recentUrls,
} from "../src/index.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("decodeEntities handles named and numeric entities", () => {
  assert.equal(decodeEntities("a&amp;b &lt;&gt; &quot;&apos; &#233; &#x6D;"), `a&b <> "' é m`);
  assert.equal(decodeEntities("&bogus;"), "&bogus;");
});

test("parseSitemap reads urlset loc and lastmod with entities and CDATA", () => {
  const { type, entries } = parseSitemap(fixture("urlset.xml"));
  assert.equal(type, "urlset");
  assert.deepEqual(entries, [
    { loc: "https://example.com/", lastmod: "2026-10-01" },
    { loc: "https://example.com/search?q=a&b=c", lastmod: "2026-10-02T10:00:00Z" },
    { loc: "https://example.com/café/menu", lastmod: "" },
    { loc: "https://example.com/cdata", lastmod: "2026-10-03" },
    { loc: "https://other.example.org/x", lastmod: "2026-10-04" },
  ]);
});

test("parseSitemap marks a non-sitemap document invalid", () => {
  assert.deepEqual(parseSitemap("<!doctype html><html><body>App</body></html>"), { type: "invalid", entries: [] });
});

test("parseSitemap detects a sitemap index", () => {
  const { type, entries } = parseSitemap(fixture("index.xml"));
  assert.equal(type, "index");
  assert.equal(entries.length, 7);
  assert.equal(entries[0].loc, "https://example.com/sitemap-1.xml?a=1&b=1");
});

test("collectUrls walks all 7 child sitemaps of an index", async () => {
  const fetched = [];
  const fetcher = async (url) => {
    fetched.push(url);
    if (url === "https://example.com/sitemap.xml") return fixture("index.xml");
    const n = new URL(url).searchParams.get("b");
    return `<urlset><url><loc>https://example.com/page-${n}</loc><lastmod>2026-10-0${n}</lastmod></url></urlset>`;
  };
  const urls = await collectUrls("https://example.com/sitemap.xml", fetcher);
  assert.equal(fetched.length, 8);
  assert.equal(Object.keys(urls).length, 7);
  assert.equal(urls["https://example.com/page-7"], "2026-10-07");
});

test("collectUrls stops on a self-referencing index", async () => {
  const fetcher = async () => "<sitemapindex><sitemap><loc>https://example.com/sitemap.xml</loc></sitemap></sitemapindex>";
  assert.deepEqual(await collectUrls("https://example.com/sitemap.xml", fetcher), {});
});

test("filterHost keeps only the site host", () => {
  const urls = ["https://example.com/a", "https://EXAMPLE.com/b", "https://www.example.com/c", "not a url"];
  assert.deepEqual(filterHost(urls, "example.com"), ["https://example.com/a", "https://EXAMPLE.com/b"]);
});

test("excludeUrls drops path prefixes and query URLs", () => {
  const prefixes = parseExclude("/go/\n  /api/ \n\n/admin/");
  assert.deepEqual(prefixes, ["/go/", "/api/", "/admin/"]);
  const urls = ["https://example.com/go/x", "https://example.com/blog", "https://example.com/api/v1", "https://example.com/blog?page=2"];
  assert.deepEqual(excludeUrls(urls, prefixes, true), ["https://example.com/blog"]);
  assert.deepEqual(excludeUrls(urls, prefixes, false), ["https://example.com/blog", "https://example.com/blog?page=2"]);
});

test("diffState finds added, changed and removed", () => {
  const previous = { "https://example.com/a": "1", "https://example.com/b": "1", "https://example.com/gone": "1" };
  const current = { "https://example.com/a": "1", "https://example.com/b": "2", "https://example.com/new": "" };
  assert.deepEqual(diffState(previous, current), {
    added: ["https://example.com/new"],
    changed: ["https://example.com/b"],
    removed: ["https://example.com/gone"],
  });
});

test("recentUrls keeps only lastmod within the window", () => {
  const now = Date.parse("2026-10-29T00:00:00Z");
  const current = {
    "https://example.com/new": "2026-10-25",
    "https://example.com/old": "2026-10-01",
    "https://example.com/none": "",
    "https://example.com/bad": "yesterday",
  };
  assert.deepEqual(recentUrls(current, 7, now), ["https://example.com/new"]);
});

test("batch splits at the limit", () => {
  const items = Array.from({ length: 25001 }, (_, i) => i);
  assert.deepEqual(batch(items).map((b) => b.length), [10000, 10000, 5001]);
  assert.deepEqual(batch([]), []);
});

test("capUrls sends the first max and keeps the rest", () => {
  assert.deepEqual(capUrls(["a", "b", "c"], 2), { sent: ["a", "b"], unsent: ["c"] });
  assert.deepEqual(capUrls(["a"], 5), { sent: ["a"], unsent: [] });
});

test("nextUrlState stores only sent URLs so unsent ones come back next run", () => {
  const previous = { a: "1", b: "1", gone: "1" };
  const current = { a: "1", b: "2", c: "1" };
  const next = nextUrlState(previous, current, ["b", "c", "gone"]);
  assert.deepEqual(next, { a: "1", b: "1", gone: "1" });
  assert.deepEqual(diffState(next, current), { added: ["c"], changed: ["b"], removed: ["gone"] });
  assert.deepEqual(nextUrlState(null, current, ["c"]), { a: "1", b: "2" });
});

test("normalizeState accepts the plain map and the full shape", () => {
  assert.deepEqual(normalizeState({ x: "1" }), { urls: { x: "1" }, gscSubmittedAt: null });
  assert.deepEqual(normalizeState({ urls: { x: "1" }, pending: ["y"], gscSubmittedAt: "2026-10-01T00:00:00Z" }), {
    urls: { x: "1" },
    gscSubmittedAt: "2026-10-01T00:00:00Z",
  });
  assert.equal(normalizeState([]), null);
});

test("gscDue respects the minimum interval", () => {
  const now = Date.parse("2026-10-29T12:00:00Z");
  assert.equal(gscDue(null, 24, now), true);
  assert.equal(gscDue("2026-10-29T00:00:00Z", 0, now), true);
  assert.equal(gscDue("2026-10-29T00:00:00Z", 24, now), false);
  assert.equal(gscDue("2026-10-28T11:00:00Z", 24, now), true);
});

test("isTruthy", () => {
  assert.equal(isTruthy("true"), true);
  assert.equal(isTruthy("false"), false);
  assert.equal(isTruthy(""), false);
});

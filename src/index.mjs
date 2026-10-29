import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
export const INDEXNOW_BATCH = 10000;
const MAX_SITEMAP_DEPTH = 3;
const MAX_SITEMAPS = 500;
const SUMMARY_LIMIT = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (match, code) => {
    const lower = code.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    const point = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    try {
      return String.fromCodePoint(point);
    } catch {
      return match;
    }
  });
}

function tagText(block, tag) {
  const match = block.match(new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "i"));
  if (!match) return "";
  const raw = match[1].trim();
  const cdata = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return cdata ? cdata[1].trim() : decodeEntities(raw);
}

export function parseSitemap(xml) {
  const isIndex = /<(?:[\w-]+:)?sitemapindex\b/i.test(xml);
  const tag = isIndex ? "sitemap" : "url";
  const blocks = xml.match(new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>[\\s\\S]*?</(?:[\\w-]+:)?${tag}>`, "gi")) ?? [];
  const entries = [];
  for (const block of blocks) {
    const loc = tagText(block, "loc");
    if (!loc) continue;
    entries.push({ loc, lastmod: tagText(block, "lastmod") });
  }
  return { type: isIndex ? "index" : "urlset", entries };
}

export function filterHost(urls, host) {
  const wanted = host.toLowerCase();
  return urls.filter((url) => {
    try {
      return new URL(url).host.toLowerCase() === wanted;
    } catch {
      return false;
    }
  });
}

export function parseExclude(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function excludeUrls(urls, prefixes, excludeQuery) {
  return urls.filter((url) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (excludeQuery && parsed.search) return false;
    return !prefixes.some((prefix) => parsed.pathname.startsWith(prefix));
  });
}

export function normalizeState(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (data.urls && typeof data.urls === "object") {
    return {
      urls: data.urls,
      pending: Array.isArray(data.pending) ? data.pending : [],
      gscSubmittedAt: typeof data.gscSubmittedAt === "string" ? data.gscSubmittedAt : null,
    };
  }
  return { urls: data, pending: [], gscSubmittedAt: null };
}

export function capUrls(urls, max) {
  if (!(max > 0) || urls.length <= max) return { sent: urls, unsent: [] };
  return { sent: urls.slice(0, max), unsent: urls.slice(max) };
}

export function nextUrlState(previous, current, unsent) {
  const next = { ...current };
  for (const url of unsent) {
    if (previous && Object.hasOwn(previous, url)) next[url] = previous[url];
    else delete next[url];
  }
  return next;
}

export function gscDue(lastSubmittedAt, minHours, now = Date.now()) {
  if (!(minHours > 0) || !lastSubmittedAt) return true;
  const last = Date.parse(lastSubmittedAt);
  return !Number.isFinite(last) || now - last >= minHours * 60 * 60 * 1000;
}

export function diffState(previous, current) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const [url, lastmod] of Object.entries(current)) {
    if (!Object.hasOwn(previous, url)) added.push(url);
    else if (previous[url] !== lastmod) changed.push(url);
  }
  for (const url of Object.keys(previous)) {
    if (!Object.hasOwn(current, url)) removed.push(url);
  }
  return { added, changed, removed };
}

export function recentUrls(current, days, now = Date.now()) {
  const cutoff = now - days * DAY_MS;
  return Object.entries(current)
    .filter(([, lastmod]) => {
      const time = Date.parse(lastmod);
      return Number.isFinite(time) && time >= cutoff;
    })
    .map(([url]) => url);
}

export function batch(items, size = INDEXNOW_BATCH) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function isTruthy(value) {
  return ["true", "1", "yes"].includes(String(value ?? "").trim().toLowerCase());
}

function warn(message) {
  console.log(`::warning::${message}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchText(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const busted = new URL(url);
    busted.searchParams.set("_di", Date.now().toString(36));
    try {
      const res = await fetch(busted, {
        headers: { "cache-control": "no-cache", pragma: "no-cache", "user-agent": "deploy-indexing" },
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(2000 * 2 ** (attempt - 1));
    }
  }
  throw new Error(`could not fetch ${url}: ${lastError?.message ?? lastError}`);
}

export async function collectUrls(sitemapUrl, fetcher = fetchText) {
  const urls = {};
  const seen = new Set();
  let fetched = 0;
  async function visit(url, depth) {
    if (seen.has(url) || depth > MAX_SITEMAP_DEPTH || fetched >= MAX_SITEMAPS) return;
    seen.add(url);
    fetched++;
    const parsed = parseSitemap(await fetcher(url));
    if (parsed.type === "index") {
      for (const entry of parsed.entries) await visit(entry.loc, depth + 1);
    } else {
      for (const entry of parsed.entries) urls[entry.loc] = entry.lastmod;
    }
  }
  await visit(sitemapUrl, 0);
  return urls;
}

function readState(path) {
  try {
    return normalizeState(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

async function submitIndexNow({ host, key, urls, dryRun }) {
  const batches = batch(urls);
  let sent = 0;
  for (const [i, urlList] of batches.entries()) {
    const body = { host, key, keyLocation: `https://${host}/${key}.txt`, urlList };
    if (dryRun) {
      console.log(`[dry-run] would POST ${urlList.length} URLs to ${INDEXNOW_ENDPOINT} (batch ${i + 1}/${batches.length})`);
      continue;
    }
    try {
      const res = await fetch(INDEXNOW_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        sent += urlList.length;
        console.log(`IndexNow: HTTP ${res.status} for ${urlList.length} URLs (batch ${i + 1}/${batches.length})`);
      } else {
        const text = (await res.text()).slice(0, 300);
        warn(`IndexNow returned HTTP ${res.status} for batch ${i + 1}: ${text}`);
      }
    } catch (error) {
      warn(`IndexNow request failed for batch ${i + 1}: ${error.message}`);
    }
  }
  return sent;
}

async function submitGsc({ token, property, sitemapUrl, dryRun }) {
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/sitemaps/${encodeURIComponent(sitemapUrl)}`;
  if (dryRun) {
    console.log(`[dry-run] would PUT ${endpoint}`);
    return "dry-run";
  }
  try {
    const res = await fetch(endpoint, { method: "PUT", headers: { authorization: `Bearer ${token}` } });
    if (res.ok) {
      console.log(`Search Console: sitemap submitted (HTTP ${res.status})`);
      return "submitted";
    }
    const text = (await res.text()).slice(0, 300);
    warn(`Search Console returned HTTP ${res.status}: ${text}`);
  } catch (error) {
    warn(`Search Console request failed: ${error.message}`);
  }
  return "failed";
}

function writeSummary(lines) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    appendFileSync(path, `${lines.join("\n")}\n`);
  } catch (error) {
    warn(`could not write step summary: ${error.message}`);
  }
}

export async function run(env = process.env) {
  const siteUrl = (env.DI_SITE_URL ?? "").trim();
  const key = (env.DI_INDEXNOW_KEY ?? "").trim();
  const token = (env.DI_GOOGLE_ACCESS_TOKEN ?? "").trim();
  const dryRun = isTruthy(env.DI_DRY_RUN);
  const days = Number.parseFloat(env.DI_FALLBACK_DAYS || "7");
  const fallbackDays = Number.isFinite(days) && days >= 0 ? days : 7;
  const statePath = (env.DI_STATE_PATH ?? "").trim();
  const exclude = parseExclude(env.DI_EXCLUDE);
  const excludeQuery = env.DI_EXCLUDE_QUERY_URLS === undefined || env.DI_EXCLUDE_QUERY_URLS === "" ? true : isTruthy(env.DI_EXCLUDE_QUERY_URLS);
  const maxRaw = Number.parseInt(env.DI_MAX_URLS || "5000", 10);
  const maxUrls = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : 5000;
  const gscHoursRaw = Number.parseFloat(env.DI_GSC_MIN_INTERVAL_HOURS || "0");
  const gscMinHours = Number.isFinite(gscHoursRaw) && gscHoursRaw > 0 ? gscHoursRaw : 0;

  let host;
  try {
    host = new URL(siteUrl).host.toLowerCase();
  } catch {
    warn(`site-url is not a valid URL; skipping indexing`);
    return;
  }
  if (!key) {
    warn("indexnow-key is empty; skipping indexing");
    return;
  }
  const origin = new URL(siteUrl).origin;
  const sitemapUrl = (env.DI_SITEMAP_URL ?? "").trim() || `${origin}/sitemap.xml`;
  const property = (env.DI_GSC_PROPERTY ?? "").trim() || `sc-domain:${new URL(siteUrl).hostname.toLowerCase()}`;
  if (dryRun) console.log("Dry run: no API calls, state is not written.");

  let current;
  try {
    const all = await collectUrls(sitemapUrl);
    const onHost = filterHost(Object.keys(all), host);
    const kept = excludeUrls(onHost, exclude, excludeQuery);
    current = Object.fromEntries(kept.map((url) => [url, all[url]]));
    const otherHosts = Object.keys(all).length - onHost.length;
    const excluded = onHost.length - kept.length;
    const notes = [otherHosts && `${otherHosts} on other hosts`, excluded && `${excluded} excluded`].filter(Boolean);
    console.log(`Sitemap: ${kept.length} URLs on ${host}${notes.length ? ` (ignored: ${notes.join(", ")})` : ""}`);
  } catch (error) {
    warn(`sitemap fetch failed, nothing submitted: ${error.message}`);
    return;
  }

  const previousState = statePath ? readState(statePath) : null;
  const previous = previousState
    ? Object.fromEntries(
        excludeUrls(filterHost(Object.keys(previousState.urls), host), exclude, excludeQuery).map((url) => [url, previousState.urls[url]]),
      )
    : null;
  let toSubmit;
  let counts;
  if (previous) {
    const diff = diffState(previous, current);
    toSubmit = [...diff.added, ...diff.changed, ...diff.removed];
    counts = { added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length };
    console.log(`Diff against saved state: ${counts.added} added, ${counts.changed} changed, ${counts.removed} removed`);
  } else {
    toSubmit = recentUrls(current, fallbackDays);
    counts = { recent: toSubmit.length };
    console.log(`No saved state: submitting only URLs with lastmod in the last ${fallbackDays} days (${toSubmit.length} of ${Object.keys(current).length})`);
  }

  const total = toSubmit.length;
  const { sent: capped, unsent } = capUrls(toSubmit, maxUrls);
  if (unsent.length) {
    warn(
      `${total} URLs to submit is over max-urls (${maxUrls}); sending the first ${maxUrls}, the other ${unsent.length} go next run. This probably means lastmod generation broke.`,
    );
  }
  toSubmit = capped;

  let sent = 0;
  if (toSubmit.length) {
    sent = await submitIndexNow({ host, key, urls: toSubmit, dryRun });
  } else {
    console.log("IndexNow: nothing to submit");
  }

  let gsc = "skipped (no token)";
  let gscSubmittedAt = previousState?.gscSubmittedAt ?? null;
  if (!token) {
    console.log("Search Console: skipped, no access token");
  } else if (!gscDue(gscSubmittedAt, gscMinHours)) {
    gsc = `skipped (last submit ${gscSubmittedAt} is within ${gscMinHours} hours)`;
    console.log(`Search Console: ${gsc}`);
  } else {
    gsc = await submitGsc({ token, property, sitemapUrl, dryRun });
    if (gsc === "submitted") gscSubmittedAt = new Date().toISOString();
  }

  if (statePath && !dryRun) {
    try {
      const urls = nextUrlState(previous, current, unsent);
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify({ urls, pending: unsent, gscSubmittedAt }));
      console.log(`State: wrote ${Object.keys(urls).length} URLs (${unsent.length} pending) to ${statePath}`);
    } catch (error) {
      warn(`could not write state: ${error.message}`);
    }
  }

  const countLine = previous
    ? `${counts.added} added, ${counts.changed} changed, ${counts.removed} removed`
    : `no saved state, ${counts.recent} URLs from the last ${fallbackDays} days`;
  const shown = toSubmit.slice(0, SUMMARY_LIMIT);
  writeSummary([
    `### Deploy indexing: ${host}${dryRun ? " (dry run)" : ""}`,
    "",
    `- Sitemap URLs: ${Object.keys(current).length}`,
    `- To submit: ${toSubmit.length}${unsent.length ? ` of ${total}, ${unsent.length} pending for next run` : ""} (${countLine})`,
    `- IndexNow accepted: ${dryRun ? "dry run" : sent}`,
    `- Search Console: ${gsc}`,
    ...(shown.length ? ["", ...shown.map((url) => `- ${url}`)] : []),
    ...(toSubmit.length > shown.length ? [`- and ${toSubmit.length - shown.length} more`] : []),
  ]);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run().catch((error) => warn(`unexpected error: ${error.message}`)).finally(() => process.exit(0));
}

# deploy-indexing

A composite GitHub Action that tells search engines what changed after a production deploy.

- Fetches your sitemap (cache-busted, retried, sitemap indexes followed).
- Diffs it against the last run's state, kept in the Actions cache: new URLs, URLs whose `lastmod` changed, and removed URLs.
- Submits those URLs to [IndexNow](https://www.indexnow.org/) (Bing, Yandex, Seznam, Naver and others).
- Optionally resubmits the sitemap to Google Search Console with `sitemaps.submit`.
- Never fails your job. API errors become `::warning::` lines.

With no saved state (first run, or the cache was evicted after 7 idle days), it submits only URLs whose `lastmod` falls in the last `fallback-days`, never the whole site.

## Run it on production only

Run it only after production deploys, never for previews. Preview URLs are not on your production host, and a preview sitemap would teach the state the wrong URLs.

## Inputs

| Input | Default | Notes |
| --- | --- | --- |
| `site-url` | required | `https://example.com` |
| `sitemap-url` | `<site-url>/sitemap.xml` | |
| `indexnow-key` | required | `https://<host>/<key>.txt` must already be live |
| `google-access-token` | empty | Empty skips Search Console |
| `gsc-property` | `sc-domain:<host>` | Or a URL-prefix property like `https://example.com/` |
| `gsc-min-interval-hours` | `0` | Skip Search Console if the last successful submit is newer. Use `24` for a site that deploys many times a day |
| `exclude` | empty | Newline-separated path prefixes dropped before diffing |
| `exclude-query-urls` | `true` | Drop URLs with a query string |
| `max-urls` | `5000` | Most URLs sent per run. The rest stay pending and go next run. Hitting it logs a warning, since it usually means `lastmod` generation broke |
| `fallback-days` | `7` | Window used when there is no saved state |
| `dry-run` | `false` | Log what would be sent, call no API, write no state |

The action has no runner opinion. It runs on whatever `runs-on` your job uses, so private repos can pass their own self-hosted runner labels. It needs Node 20 or newer on the runner.

## Usage

### A step after your deploy job

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: ./deploy.sh

  indexing:
    needs: deploy
    runs-on: ubuntu-latest
    steps:
      - uses: vinenastudio/deploy-indexing@v1
        with:
          site-url: https://example.com
          indexnow-key: ${{ secrets.INDEXNOW_KEY }}
          exclude: |
            /go/
            /api/
            /admin/
```

### Vercel production deploys (`deployment_status`)

```yaml
on: deployment_status

jobs:
  indexing:
    if: >-
      github.event.deployment_status.state == 'success' &&
      github.event.deployment.environment == 'Production'
    runs-on: ubuntu-latest
    steps:
      - uses: vinenastudio/deploy-indexing@v1
        with:
          site-url: https://example.com
          indexnow-key: ${{ secrets.INDEXNOW_KEY }}
```

### Cloudflare Workers Builds (`check_run`)

Workers Builds reports each build as a check run on the commit. Match only the production branch.

```yaml
on:
  check_run:
    types: [completed]

jobs:
  indexing:
    if: >-
      github.event.check_run.conclusion == 'success' &&
      startsWith(github.event.check_run.name, 'Workers Builds') &&
      github.event.check_run.check_suite.head_branch == 'main'
    runs-on: ubuntu-latest
    steps:
      - uses: vinenastudio/deploy-indexing@v1
        with:
          site-url: https://example.com
          indexnow-key: ${{ secrets.INDEXNOW_KEY }}
```

## Google Search Console

The action only calls `sitemaps.submit`. It never uses the URL Inspection API or the Indexing API.

Get a token with [google-github-actions/auth](https://github.com/google-github-actions/auth) and workload identity federation, so no JSON key is stored. Add the service account as an owner of the Search Console property.

```yaml
jobs:
  indexing:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - id: auth
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: projects/123456789/locations/global/workloadIdentityPools/github/providers/github
          service_account: indexing@example-project.iam.gserviceaccount.com
          token_format: access_token
          access_token_scopes: https://www.googleapis.com/auth/webmasters
      - uses: vinenastudio/deploy-indexing@v1
        with:
          site-url: https://example.com
          indexnow-key: ${{ secrets.INDEXNOW_KEY }}
          google-access-token: ${{ steps.auth.outputs.access_token }}
          gsc-min-interval-hours: 24
```

The token is passed as an env var and never printed.

## State

State is one JSON file per host in the Actions cache (`deploy-indexing-<host>-<run_id>-<run_attempt>`, restored by the `deploy-indexing-<host>-` prefix). Matrix jobs that index the same host in one run are not supported, since they would share one cache key: `{ "urls": { "<url>": "<lastmod>" }, "pending": [], "gscSubmittedAt": null }`. The file sits at `.deploy-indexing/<host>.json` in the workspace. `urls` holds every sitemap URL except the capped and failed ones, so those come back in the next run's diff. On a first run, URLs outside the `fallback-days` window are saved as the baseline without being sent. `pending` is informational only: it lists those capped and failed URLs. A sitemap that does not parse, or an empty sitemap when the state has URLs, keeps the old state. Delete the cache entries to start over with the `fallback-days` window.

## Local run

```sh
DI_SITE_URL=https://example.com DI_INDEXNOW_KEY=yourkey DI_STATE_PATH=./state.json DI_DRY_RUN=true node src/index.mjs
node --test test/
```

## License

MIT

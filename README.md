# repo-heat-map

A dependency-free GitHub Pages **repository activity atlas** for `MrHakan`.

It goes beyond stars/forks and precomputes deeper public-repository telemetry during deployment using GitHub Actions:

- repository × week commit heat map
- most commits in the last 52 weeks
- code churn (`additions + deletions`) in the last 52 weeks
- additions vs deletions balance
- active-week consistency score
- weekly commit pulse across all tracked repositories
- lifetime commit estimate from GitHub contributor stats
- commit velocity normalized by repository age
- automatically derived repository fingerprints/outliers
- sortable deep-stats table

The heavy GitHub API work runs in Actions with `GITHUB_TOKEN`, so the public page itself stays static, fast, and does not burn through a visitor's unauthenticated API rate limit.

## Data refresh

`.github/workflows/pages.yml` rebuilds the analytics JSON and deploys the site:

- on pushes to `main`
- manually via `workflow_dispatch`
- once per day via cron

Generated data lives in the deployment artifact at `data/stats.json`.

## Live

https://mrhakan.github.io/repo-heat-map/

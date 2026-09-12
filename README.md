# repo-heat-map

A small, dependency-free GitHub Pages dashboard for visualising repository activity and useful account-level repository statistics for **MrHakan**.

**Live site:** https://mrhakan.github.io/repo-heat-map/

## What it shows

- Repository commit heat map for the 12 most recently active repositories (last 52 weeks)
- Weekly commit trend aggregated from the tracked repositories
- Repository totals: public repos, stars, forks, open issues, active repositories
- Primary-language distribution
- Most-starred repositories
- Searchable/sortable repository table
- Recent repository activity

The dashboard uses GitHub's public REST API directly in the browser and caches responses locally to reduce API usage. No analytics, trackers, frameworks, or build step are used.

## Run locally

Serve the repository with any static web server, for example:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

## GitHub Pages

This repository includes a Pages workflow. In **Settings → Pages**, set the source to **GitHub Actions** if it is not already selected. Pushes to `main` will deploy automatically.

## Notes

GitHub's unauthenticated API has a rate limit. The app caches repository data and commit statistics in `localStorage`; use the refresh control only when needed.

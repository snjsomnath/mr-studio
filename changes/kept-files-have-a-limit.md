---
bump: minor
issues: 516
---
### What a table keeps for offline use has a limit, and you can see it

A table keeps every map tile, map picture and service answer it fetches, so it works without the internet. Nothing ever removed any of it, so a table that ran for months, or was moved around a city, only grew (#516).

Now the kept files stay within a limit (500 MB of maps, 200 MB and 2000 answers per service). When a table starts, and once a day, the files fetched longest ago are removed. The media library says how much is kept and has a **Clear** button; your own files are never touched.

![Kept for offline use, under the media library](docs/screenshots/516-kept-for-offline.png)

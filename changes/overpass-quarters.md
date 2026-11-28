---
bump: patch
issues: 706
---
### OpenStreetMap no longer comes back empty for busy city centres

Sometimes OpenStreetMap stops a request part-way because the area holds more than one small request may ask for. MR Studio used to take that cut-short answer as the whole data, so buildings or streets came back empty or with gaps (#706). Now it notices and asks for that part in quarters, each small enough for a busy server.

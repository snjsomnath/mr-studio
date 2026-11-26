---
bump: patch
issues: 603
---
### OpenStreetMap fetches get through when the servers are busy

Fetching buildings, trees, streets or water from OpenStreetMap now gets through far more often (#603). Each request asks for a small share of the server, which a busy server still accepts. MR Studio waits for its turn when the server says when one frees, and leaves a server alone for 30 s after it says "too many requests", as the server's operators ask. Parts that already came back are kept, so trying again only asks for what is missing. A third public server (VK Maps) is asked when the other two are busy.

![The Fetch everything dialog waiting for a free turn](docs/screenshots/603-waiting-for-turn.png)

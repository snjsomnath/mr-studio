---
bump: patch
issues: 706
---
### OpenStreetMap fetches no longer time out on the Mac, or come back empty

On the Mac, the app window gave up on an OpenStreetMap fetch that took more than a minute, and showed "timed out", even though MR Studio was still waiting its turn at a busy server (#706). The fetch now tells the window it is still working every few seconds, so the window waits as long as the fetch needs. When OpenStreetMap stops a request part-way because the area holds more than one small request may ask for, MR Studio no longer takes the cut-short answer as the whole data. It asks for that part in quarters instead.

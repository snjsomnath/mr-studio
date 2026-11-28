---
bump: none
issues: 760
audience: developers
---
### End-to-end checks wait longer for a change to reach a second editor

The end-to-end case for two editors (#396) failed on main about half the time: the CI runner is about four times slower than a laptop, and a change made in one editor sometimes took more than 5 seconds to show in the other. `until` in `scripts/e2e/studio.cjs` now waits up to 15 seconds by default. A check that holds still returns at once.

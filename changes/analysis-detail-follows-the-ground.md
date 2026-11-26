---
bump: minor
issues: 513
---
### Big tables stay fast: the analysis grid follows the ground

A table made in the app always worked out sun, wind and shade on 1 m squares. A 4 km table had almost ten million of them and crawled, and a 10 km table was refused with a message about a file setting (#513).

Now the squares follow the ground: 1 m for a neighbourhood, 3 m for a 4 km district, 6 m for a 10 km city, about two million squares in every case. **Analysis detail** in Table size and place says what the table uses and lets you choose Fine, Normal or Coarse; the choice is kept when the table is resized. Tables you already have keep their squares until you resize them or choose a detail.

![Analysis detail in Table size and place](docs/screenshots/513-analysis-detail.png)

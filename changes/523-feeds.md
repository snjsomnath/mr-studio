---
bump: minor
issues: 523
---
### Playback shows what live feeds said at the time

While a session records, MR Studio now keeps what the outside answered: public transport positions, WMS map pictures, a source's tiles and requests, and a table's own services (#523). Played back, the table shows those answers as they were at that moment, even with the network off, and reaches nothing outside. Each different answer is kept once, at most 512 MB per recording, and it travels in the .mrsession file.

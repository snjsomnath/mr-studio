---
bump: patch
issues: 504
---
### Only the studio computer runs the table

With Phones on, anything on the phones' network could claim to be the controller and rearrange or wipe the table (#504). Now the table, the screens and the controller are accepted only from MR Studio's own windows on the studio computer. Everything else is a phone or the guide.

A web page from another site, open in a browser on the studio computer, can no longer move the table or replace its data either. Visitors' devices are no longer served `site.json`, the table's history, diagnostics or service logs, the join code is told only by the QR code, and a code cannot be found by trying them all: after 10 wrong codes in a minute an address waits.

![What the host answers a laptop on the phones' network, a page from another site and MR Studio's own windows](docs/screenshots/504-who-may-do-what.png)

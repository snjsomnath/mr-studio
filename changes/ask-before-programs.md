---
bump: minor
issues: 506
---
### A table asks before it runs its own programs

A table can bring programs with it: services the app starts, and the code of its own layers. Opening a table file from an email used to run them without a word (#506). Now MR Studio names them and asks first: **Run them**, **Open without them** or **Cancel**.

Tables made on this computer are never asked about. A folder you open is asked about once. A table that arrived as a `.mrstable` file is asked about once, and again if an update brings other programs. Opened without them the table still shows: its services are held, and its own layers say they are not running.

![The question MR Studio asks before a table's programs run](docs/screenshots/506-ask-before-programs.png)

![A table opened without its programs: its own layer says why it is not running](docs/screenshots/506-opened-without.png)

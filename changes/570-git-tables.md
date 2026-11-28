---
bump: minor
issues: 570
---
### Get a table from a git repository, and update it from there

For teams that keep a table in GitHub or GitLab (#570): **Get a table from a git repository…** under Your tables on Home takes the repository's address and keeps the table in your tables folder. When someone pushes a new version, the table's card says **Update from the repository** with how many changes are new. The studio computer only follows the repository: a table changed there is not updated over, nothing updates while it is on the screens, and its calibration stays as it was. Signing in is git's own; Git LFS is needed for tables that keep big files with it.

![A table that follows its repository](docs/screenshots/570-git-card.png)
![Get a table from a repository](docs/screenshots/570-git-dialog.png)

---
bump: none
issues: 570
audience: developers
---
### The site template checks the table on GitLab too

The site template now has a `.gitlab-ci.yml` beside its GitHub check, for teams that keep their table on GitLab, such as Chalmers GitLab (#570). It installs the `mrstudio` command line at the version in `mrstudio.version` and runs `mrstudio validate .`, the same as the GitHub check. The template's README explains how to import the template on GitLab, which has no "Use this template" button, and when to use Git LFS for videos and hourly rasters. The app still doesn't fetch a table from a repository by itself; that part of #570 is still open.

![The GitLab check's job and the validate it runs](docs/screenshots/570-gitlab-check.png)

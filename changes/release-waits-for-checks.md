---
bump: none
issues: 505
---
### A version is published only after its checks pass

The release run now starts with the same checks a pull request gets, on the merged commit. A commit whose checks fail makes no version: its release notes wait and go out with the next merge that passes. Checks on main are no longer cancelled when another pull request merges soon after.

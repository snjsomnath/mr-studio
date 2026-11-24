---
bump: minor
issues: 328
---
### Development requests from the MCP server check for duplicates and are ready to build

When an experience needs something MR Studio cannot do, the MCP server now writes an issue a developer can act on: a kind (layer enhancement, new layer, block, kernel, data integration, interaction, site setting, SDK or runtime, architecture, other), the context, a user story, the proposed functionality, what the table, controller and phones do, technical considerations, acceptance criteria, dependencies and current limitations. `find_related_issues` and the draft search open and closed issues first, and `submit_development_request` searches again and holds back a likely duplicate unless the person says it differs. One yes can send a batch. Issues get `development-request`, their kind and `needs-triage`, and are added to the build order in #49 at triage. An issue number is reported only when GitHub returned it; without a sign-in or permission nothing is sent and the prefilled link comes back. A new issue form, `development-request.yml`, matches the sections. `check_layer_idea`, `list_building_blocks`, `draft_module_request` and `submit_module_request` still work for this release only.

![find_related_issues, the request sections, and a batch where the duplicate is held back](docs/screenshots/328-requests.png)

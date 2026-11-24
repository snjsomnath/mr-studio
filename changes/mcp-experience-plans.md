---
bump: minor
issues: 327
---
### The MCP server designs a whole experience, builds what exists and names what does not

An LLM can now take one sentence, such as "residents understand how the proposed development changes sunlight and wind, and contribute ideas", and turn it into an experience plan: steps with what the table shows, what the controller says, what phones do and the guide's notes, plus layers at rest and other needs. `assess_experience` checks the plan against the capability catalogue and says, for each step, which layer serves it, what setup it still needs, which constraint it runs into (no 3D on the table), and which gaps need a development request of which kind. `build_experience` writes the parts that exist in one validated change, including a guided sequence with notes, and never writes a gap into `site.json`. New prompts: `design_experience`, `plan_workshop`, `compare_scenarios` and `build_from_data`; `new_project` now starts from the experience, and `check_layer_idea` also returns its idea as a one-step plan.

![assess_experience and build_experience on the residents example](docs/screenshots/327-experience.png)

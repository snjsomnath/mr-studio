---
bump: minor
issues: 192
---
### The campus energy community (ECOM) on the Chalmers table
The Chalmers table has the energy community from the old interactive map, rebuilt on 2.0's building blocks as a test of how well a code-heavy layer ports. It plays a summer day. Energy flows along the streets from roofs, the grid and the battery, and each building fills by how much of its use the community covers that hour. On the controller you can:

- tap a building to take it out of the community or change the solar on its roof
- watch self-sufficiency and where the power comes from
- compare the day's grid import together against each building on its own

With the ECOM model running, a change asks the model again. Without it, the last exported day is shown. What the port still needs from the SDK is in #373.

![The controller: a building taken out of the community on the panel map, and the numbers it changed](docs/screenshots/192-controller.png)

![The table: flows along the streets, buildings filled by the hour, the building taken out outlined](docs/screenshots/192-table.png)

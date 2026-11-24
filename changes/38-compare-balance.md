---
bump: minor
issues: 281
---
### Compare scenarios and show a balance, on the controller and in the ribbon
Two new dashboard panels say what a crowded dashboard used to. **Compare** puts two or three scenarios side by side, such as "as today", "this plan" and "the best share", with one figure each and how far each is from the first. A scenario that is not worked out yet says **Not run** or **Working…** instead of showing an old number. **Balance** shows where something came from and where it went, as two bands split by share, with one headline number such as self-sufficiency. Both bind to what a layer publishes, count towards the density budget, follow the theme, and come as chips for the table's ribbon. The model-runs sample (`samples/service-example`) uses both.

![Compare and Balance on the controller, after the optimiser found the best share](docs/screenshots/281-controller.png)
![The best share being worked out: its card says Working…](docs/screenshots/281-controller-running.png)
![The ribbon in front of the model, with the chip forms: 36 % less from the grid, 36 % self-sufficient](docs/screenshots/281-ribbon.png)

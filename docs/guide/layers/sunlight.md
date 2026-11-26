# Sunlight

## What it shows

Shadows of the buildings and trees at any date and time, or how many hours of direct sun each spot gets over a day. **Golden hour** plays the warm low light around sunset (or sunrise) on a slow loop. **Seasons** compares midsummer, the equinox and midwinter. **Daylight rule** checks open ground against a planning rule and colours each spot pass or fail.

![Sun hours over a day](docs/screenshots/137-sun-hours.png)

## Good for

Showing where a courtyard gets sun, how a new building shades its neighbours, and how short winter days are in the north.

## Set it up

1. Make sure the table has buildings (and ground heights and trees if you have them): Insert tab, **Data file**.
2. Add **Sunlight** from **Add a layer**. It gets a button on the controller.
3. Under **Show**, pick **Shadows**, **Golden hour**, **Sun hours**, **Seasons** or **Daylight rule**.
4. Set the **Day** and the **Time of day**. **Animate the day** plays the sun from morning to evening.
5. To flag spots that get too little sun, set **Flag areas with less sun than** a number of hours.
6. Visitors can point at a spot with **How much sun here?** on their phone, or click on the table, to read the sun hours right there.

## Tips

- **Shadow trails over the day** draws every shadow of the day at once, which shows the sun's sweep in one picture.
- **Golden hour** starts playing as soon as it is picked: in the evening the sun sinks from 6° up to 4° under the horizon (in the morning it rises the same way), the blue hour holds a moment, and it starts again. Pick **Evening** or **Morning** under **Golden hour**; the controller's timeline marks both in gold.
- **Daylight rule** judges the ground outside buildings. **Sweden (Boverket)** is the default: at least half of it needs 5 hours of sun between 9 and 17 at the spring equinox, the measure Boverket's guidance on play and school yards uses. **UK (BRE)** asks for 2 hours on 21 March over at least half the area. Each rule sets its own day; **Sun a place needs** and **Share of open ground that must pass** can then be changed for a municipality's own numbers. The controller and TV show the share that passes and whether the area passes.

  ![Daylight rule](docs/screenshots/498-daylight-rule.png)
- **What if?** Visitors can change the place from their phone: **Add a building** (draw its outline; it stands as tall as **New building height**), **Plant a tree**, or **Take a building or tree away** (tap it). The shadows and sun hours redraw with the change, and every simulation on the table sees it while Sunlight is open. On the controller, **Undo the last change** and **Take away all changes** undo them. Nothing is saved, and closing Sunlight brings the real place back. While changes are in place, shadows come from the simulation's cells and are a little blockier than the 3D model's.

  ![A new 40 m block, a row of trees and a building taken away](docs/screenshots/500-what-if.png)
- If shadows look wrong, check that the table faces the right way in its place (Design tab, **Table size and place…**).

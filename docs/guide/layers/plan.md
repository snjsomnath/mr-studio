# Masterplan

## What it shows

A plan drawing laid over the table, brought in one phase at a time: first the whole plan, then each part grows in as visitors press Next.

![A plan revealed phase by phase](docs/screenshots/193-table-3.png)

## Good for

Presenting a masterplan or a vision step by step, as the Chalmers campus demo does.

## Set it up

1. Draw or export the plan as an **SVG** from Illustrator or Inkscape. Put each phase on its own layer and name the layers as you want them shown ("Primary routes", "New housing").
2. Draw it to the table's shape: its top is the table's top.
3. In **Add data**, bring in the SVG.
4. Add **Masterplan** from **Insert › New layer** and choose the drawing under **Drawing**.
5. Press **Next** on the controller to bring in each phase. **Previous** takes it back out.

## Tips

- Anything outside the named layers is always shown, so put the base drawing there.
- The controller lists the phases in their colours, and their names can be translated in Design, **Welcome and languages…**.
- **An artwork that draws itself**: set **When it opens** to *Its lines trace in*, add a **Colour version**, and set **Before the first Next** to *Only what is outside the phases*. A layer named *Base* is the line work under the phases. **Place by its corners** puts a drawing of any shape where it belongs on the map.
- **Parts that move by what they are**: name the groups in each phase *Boundary*, *Main axis*, *Routes*, *Arrows*, *Points*, *Nodes* or *Green spaces*, and number the phases (*01_*, *02_*...). The boundary then marches, the axis grows from its middle, points pop in and green spaces breathe. `samples/kit/drawing/masterplan-roles.svg` is a template.

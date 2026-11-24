# Mobility

## What it shows

People travelling: each trip is a dot moving along its route over time, coloured by group (on foot, by bike, by tram). Under the trips it can show a map of values per area, such as travel time or delay.

![Trips across the city](docs/screenshots/76-mobility-hero.png)

## Good for

Comparing ways of getting somewhere, showing how long a journey really takes, and where people wait for connections.

## Set it up

1. Prepare a **trips** file: each trip with its group and its legs, each leg with a start time, a length and its route. The format is in the layer's documentation (packages/layers/mobility/README.md); a researcher or a script usually makes it.
2. In **Add data**, choose **Trips** and bring the file in. A map of values per area goes in as a dataset named **trip_cells**.
3. Add **Mobility** from **Add a layer**.
4. Press **Play**. **Speed** sets how fast time passes; **Time** jumps to a moment.

## Tips

- A ring around a dot means that person is waiting, for example for a tram.
- The controller counts arrivals per group, so the fastest way of travelling is plain to see.

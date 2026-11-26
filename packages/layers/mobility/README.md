# Mobility

People on the move. The layer plays a site's trips over time as dots travelling along their routes,
coloured by group, with a ring around anyone waiting for a connection and a count of arrivals per group.
Under the trips it can show a map of values per cell (for example travel time or delay) that steps through
the same time span.

This is the core of the two Universeum mobility exhibits (journeys at two walking speeds, and the delay
heat map by departure time) with everything specific to that study taken out. The story, the groups, the
destination and the numbers now come from the site's data.

## What a site provides

```jsonc
// site.json
"data": { "trips": "data/trips.json", "trip_cells": "data/trip-cells.geojson" },
"layers": [{ "use": "mobility" }]
```

Those are the default names. Each copy of the layer can name its own datasets in its settings,
**Trips from** (`tripsData`) and **Map of values from** (`cellsData`), so one table can tell more
than one mobility story (#486):

```jsonc
"data": { "slow-walkers": "data/slow-walkers.geojson" },
"layers": [{ "use": "mobility", "id": "slow-walkers", "params": { "tripsData": "", "cellsData": "slow-walkers" } }]
```

The layer needs at least one of the two. Without a map of values it shows trips only. Without trips it
plays the map of values a step at a time (about four seconds a step at Normal speed), and the controller
shows each step's name from `metadata.steps` instead of a clock.

### trips

```jsonc
{
  "format": 1,
  "title": "Getting to the square",        // optional, shown on the TV
  "duration": 840,                          // seconds; defaults to the end of the last leg
  "groups": [                               // optional; groups are otherwise taken from the trips
    { "id": "walk", "label": "On foot", "color": "#fb923c" },
    { "id": "tram", "label": "Walk and tram", "color": "#2dd4bf" }
  ],
  "destination": { "label": "The square", "coordinates": [11.97, 57.70] },   // optional marker
  "trips": [
    {
      "group": "tram",
      "legs": [
        { "start": 30, "duration": 130, "coordinates": [[11.96, 57.70], [11.965, 57.70]] },
        { "start": 240, "duration": 22, "coordinates": [[11.965, 57.70], [11.97, 57.70]] }
      ]
    }
  ]
}
```

Times are seconds from the start of the dataset. Coordinates are WGS84 `[lon, lat]`. A traveller moves
along a leg at constant speed, waits where a leg ended until the next one starts, and has arrived when
the last leg ends. Trips to compare (the same journey made two ways) are simply two trips in different groups.

### trip_cells

GeoJSON polygons in WGS84. Each feature has `properties.values`, one number per step (`null` for no data),
or a single `properties.value`. The collection may carry:

```jsonc
"metadata": { "label": "Minutes on foot to the square", "unit": "min", "steps": ["07:00", "08:00"], "min": 0, "max": 15 }
```

`min` and `max` fix the colour scale; they default to the range of the data. The steps share the time span evenly.

## Controls

Play, time (0 to 100% of the span, also from a phone), speed, and what to draw. While playing, the table
owns the clock and reports the time a few times a second; moving the time control seeks.

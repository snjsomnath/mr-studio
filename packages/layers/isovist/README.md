# Isovist

What a person standing at one point on the table can see: the view is cast as 180 rays against the
site's building footprints and tree crowns, within a human 120° field of view or all round, up to
200 m. The table shows the view in yellow with a breathing pink edge, the buildings and trees it
reaches in their colours, the viewer as a red dot with the way they look, and the trail they walk.
This is the Chalmers demo's Interactive Isovist (interactive_map `animations/isovist.js`), rebuilt
from SDK blocks (`isovist`, `Soundscape`), drawn top-down in 2D.

## Using it

- **Mouse on the table or the editor:** click to stand somewhere; the viewer looks at the pointer and,
  with "The viewer walks after the pointer" on, walks after it once it is 50 m away (as in the demo).
  Press on the viewer and drag to carry it.
- **Touch:** tap to stand, drag to walk; the viewer looks the way it walks.
- **Phones:** the two point tools, "Where you stand" and "Where you look".

Every pick goes through the host, so the projector and the editor's live table show the same view.

## The controller

The hero shows Google Street View from where the viewer stands, looking their way, sent on after
3 m of walking or 15° of turning (the demo's throttle). Over it: the green view factor (the share of
rays that end in a tree crown) with the demo's rating (30% good, 15% fair), what is in view, what the
soundscape sounds like, and a bar of what the view is made of (open sky, trees, building types).
The table also draws Street View's real camera positions as a fading green trail.

Street View needs a Google Maps key with the Street View Static API turned on. Add **Google Street
View** in Sources; the key stays in the Keychain or the Credential Manager and the host signs each
request, so it never reaches a page. Without a key, the hero shows the view's make-up over a drawing.

## Soundscape

Two looping beds, nature and city, mixed by the green view as in the demo: nature at gvf × 0.5,
city at (1 − gvf) × 0.5, eased a tenth of the way per frame. Walking from a street into a park fades
traffic into birdsong. It plays on the table's own speakers (and in the editor only when listening is
turned on there). Until a site adds recordings, built-in beds made from numbers play. To use the demo's
recordings, put them in the site's `data/sounds/` and name them in the layer's params:

```jsonc
{ "use": "isovist", "params": { "nature": "XC372879 - Thrush Nightingale - Luscinia luscinia.mp3", "city": "city.mp3" } }
```

## What a site provides

`buildings` (the scene's footprints; Lantmäteriet's `objekttyp` names the building types) and, if it
has them, `trees` (points; a `crown_radius`, else 2 m + 0.3 m per metre of `height`).

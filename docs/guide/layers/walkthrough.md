# Video walk

## What it shows

A video someone filmed while walking plays on the controller, and on the table a dot walks the same route in step with the film, with what they can see drawn around them.

![The walk on the controller](docs/screenshots/194-tv-playing.png)

## Good for

Letting visitors experience a street at eye level while seeing where they are on the model.

## Set it up

1. Film the walk, and record the route (a GPS track, or draw the line afterwards).
2. In **Add data**, bring in the video (MP4 works everywhere) and the route as GeoJSON. Name the route `walk` or `route` so the layer finds it.
3. Adding a video puts a **Video walk** on the table, set to it. Otherwise, add it from **Add a layer** and choose the video and the path.
4. On the controller, visitors play, pause and scrub the film; the walker follows.

## Tips

- If the route has times for each point, the walker is exactly where the filmmaker was. Without times, it walks at an even pace.

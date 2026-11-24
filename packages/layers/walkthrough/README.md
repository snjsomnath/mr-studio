# Video walk

A video someone filmed while walking plays on the controller, and on the table the walker moves along the path they took, in step with the picture (#194), as the Chalmers demo's VR walk did.

Bring both in from the editor (Add data, datasets of your own):

- The video: MP4 (H.264) plays on every screen; QuickTime and WebM come in too. The host reads its length and picture size from its headers (`crates/mrs-site/src/video.rs`). Adding a video from Add data puts a Video walk on the table, set to it.
- The path, as GeoJSON: a LineString (or several, walked one after another), or Points in the order they were walked. Name it like a path (`walk`, `route`, `path`, `movement`, `track`) and the layer finds it by itself.

The walker keeps an even pace along the path over the length of the video. When the path knows its times, the walker is where the filmmaker was: a line's `properties.times` (or `timestamps`), one per vertex, or each point's `t`, `time`, `seconds` or `timestamp` (seconds, or an ISO date and time). Times count from the first.

On the controller the hero is the video, with play and pause and a scrubber. On the table the whole walk shows faintly dashed, the part behind the walker as a bright trail, and the walker as a glowing dot pointing the way they go. With "Show what the walker sees" on, their field of view (90°, as far as 120 m) is drawn from the buildings and trees, as the Isovist layer does.

Params: `view`, `loop`, `video` (a dataset; empty takes the table's first video), `path` (a dataset; empty takes the first GeoJSON named like a path), `opacity`.

The play state lives in params that are never shown (`tier: "state"`, docs/contracts/present.md): `playing`, `at` (the second the video was at) and `since` (when, in Unix milliseconds). The hero writes them on play, pause and scrub; every view of the table runs the clock from there, timing a change from when it arrived so another computer's clock does not matter. The video on the controller is moved back to the clock when it drifts by more than 0.3 s.

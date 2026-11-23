# Picture or video

A picture or a video of the site laid over the whole table (#197): a slideshow step beside web maps and layers, or a layer with its own button.

| Control | What it does |
| --- | --- |
| `file` | The picture (PNG, JPEG, WebP, GIF) or video (MP4, WebM), as a path inside the site, such as `data/media/sunstudy.mp4`. The editor's Slides list adds files there (`POST /api/data/media`) |
| `fit` | `stretch` to the table's edges (default), `contain` the whole picture with margins, or `cover` the table, cropping |
| `rotation` | `"0"`, `"90"`, `"180"` or `"270"`: a quarter turn clockwise for pictures made with north up on a table whose long side runs north to south |
| `loop` | A video plays again from the start (default on) |
| `opacity` | 0.1 to 1 |

A video plays, muted, from the start while the layer is on show and stops when it goes. Like the slideshow, an open media layer hides the map at rest.

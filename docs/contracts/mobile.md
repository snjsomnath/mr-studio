# Mobile controller contract

The phone UI is a surface like any other. It is served by the studio's own host from the same build as the table, so the phone and table can never be on different versions and no internet is needed.

## Joining

1. The TV shows a QR code for `http://<studio-lan-address>:<port>/phone?c=<code>` (the session's `join_url`; through the join page or the relay it is their address instead), with the address and the code beside it for typing. The code is the session's join code. `/phone` without a code asks for it.
2. The phone opens the page and sends `hello` with `role: 'phone'` and the code.
3. The host assigns a free slot (number and colour) and announces it to every surface.
4. The `welcome` carries a `resume` token. The page keeps it (local storage, per session code) and sends it in every later `hello`.
5. When a phone's connection ends, its slot is held for 60 seconds and shown as away (`connected: false`). A `hello` with the token inside that time returns the phone to the same slot and colour. After 60 seconds the slot is released and the token is worthless.

The host limits the number of phones (default 8) and answers further joins with a "session full" error the page shows. Held slots count as taken.
A phone that goes silent without closing (asleep, out of range) is noticed within 30 seconds, and its hold starts then.
One token is one phone: a second tab with the same token takes the slot over and the first tab is told to stop.

## What a phone can do

- Be someone (#339): every phone that joins gets an animal nobody else here has and a fun name, "Sunny Fox", on its colour. Tapping it at the top of the page opens a sheet to type a name of its own (at most 32 characters) or pick another animal. The controller shows each phone's animal on its colour under the QR code, faded while it reconnects, with its name on hover, and says "Sunny Fox turned on Wind" when a phone switches a layer.

- See every layer of the table as a list, in a light theme (#335). Tapping a layer opens its own page, with a back arrow (the phone's Back button works too), its switch, and **Controls** and **Map** tabs when it has both; opening a page changes nothing on the table. On the page a visitor changes the controls marked `phone: true`; a layer's `primary` controls are for phones too unless they say `phone: false`. A layer that is off shows its controls greyed with how to turn it on.
- Turn a layer on or off with its switch (#335).
  Turning a layer on from a phone closes the open layer, as its button on the controller does. The controller shows a short line, "Wind turned on from a phone", with a dot in that phone's colour.
  Phones cannot switch layers while a slideshow or tour is showing, on a table with `tv.phone_switch: false` (Table settings, "Phones can switch layers"), or for a layer whose layer.json says `"phone_switch": false` (the slideshow does).
- Use a layer's tools on its **Map** tab: tap a point, draw a line or polygon, or draw with a pen. The result is sent as `tool.input` in WGS84.
  A point is sent on touch and follows a dragged finger. A line or polygon is built corner by corner (with undo) and sent when the person presses send. A `freehand` line (the sketch's Pen and Arrow) follows one stroke and is sent when the finger lifts.
  The map shows a light base map (OpenStreetMap through the host's tile cache, which lets phones have the tiles around the table only), the site's building footprints and the table's edge, and maps finger positions through the site's `corners`, so it needs no map library. Two fingers pan and zoom (a mouse wheel zooms), **Fit table** goes back to the whole table, and the corner button opens it full screen.
- Draw on the table with the Sketch layer: a place that follows the phone, pen strokes, arrows, routes and areas, each in the phone's colour. **Take back my last mark** removes that phone's own last mark; on the controller it removes the last mark anyone made. The table's attention cue shows the phone's animal on its colour where a mark lands (#423).
- Press actions marked `phone: true`.
- Go on a field walk (#445), while the table has a Field walk layer, whatever it is showing: **Mark a spot** places the phone by GPS (or by a tap on the small map), takes a photo with the phone's camera or records a sound (at most a minute), with a note of at most 140 characters. Each spot is kept on the phone (IndexedDB) and sent when the table can be reached: `field.add { id, kind, at, lon, lat, accuracy, placed, note, mime, bytes, duration, walker }` answers `{ have }`, the bytes the host already has, and `field.part { id, offset, data }` (base64, at most 192 kB a piece) goes on from there, so a dropped phone resumes. `walker.id` is kept on the phone, so a phone back after its seat was given up is the same walker. Photos are scaled on the phone to 1600 px JPEG. The host takes files up to 8 MB, photos as JPEG, PNG or WebP and sounds as WebM, Ogg, MP4/AAC, MP3 or WAV, spots within 5 km of the table and 600 spots in all. Spots live in `<table>/.mrstudio/field/`, which a shared table leaves out; `/api/field` and the files are for the studio computer only, and `/site/.mrstudio/field` refuses the network. GPS and recording need a secure context (the join page or the relay); on plain local Wi-Fi the visitor taps the map and picks a recording.

## Looking after the phones

The operator's Developer window has a **Phones** panel (#335): **Pause the phones** (`phones.pause`: phones can look around but change nothing, and see a line saying the table is paused), each phone with **Let go** (`phones.release { slot }`: the phone is told its turn has ended and can join again), **End the round** (pressed twice: every phone is let go and every sketch cleared) and **Download the session log** (`phones.log`, as JSON: who joined, left, switched, set, pressed and drew, and when).

A phone cannot reset the table, publish values or open engine streams, and switches layers only as above. The host enforces this by role; the page hiding a control is not the protection.

## The guide's phone

A guide's phone (`/guide?g=<code>`, see session.md) is not a visitor's phone: it has its own code, takes no slot, and shows the slideshows of the table, then the steps of the running one with the guide's notes, the next step's title, Previous and Next, and a way to end the tour and send the table back to rest.

## Limits

- Surfaces coalesce param changes: at most one request per animation frame, carrying the latest values.
- On a phone, repeated requests of one kind (a dragged slider, a dragged point) are spaced at least 80 ms apart.
- The host accepts at most 20 requests per second per phone and refuses the rest with `rate limited`. The limit belongs to the slot, so reconnecting does not reset it.

## Reaching the studio

The default is the local network.

- **Join page** (#275): for venues with only eduroam or mobile data, without a server of our own. The QR code opens a static page on GitHub Pages that reaches the controller over WebRTC and loads the phone page from the table through it. Same rules as the relay. See [docs/join-page.md](../join-page.md).
- **Relay** (#89): for venues where phones cannot reach the studio's network (guest Wi-Fi with client isolation, or phones on mobile data), the host opens one outbound WebSocket to a relay and the QR code points at the relay instead. Phones speak the same protocol through it. Setting one up is in [docs/relay.md](../relay.md).
- **HTTPS**: phone features that need a secure context (camera, motion sensors) require the join page or the relay (both HTTPS) or a local certificate. Plain controls and tools do not.

Through the relay a phone gets exactly what it gets on the local network and nothing more. The host treats relayed requests as coming from the network, so routes that only the studio computer may use refuse them. Only GET and HEAD pass, and a socket through the relay must open with a phone's `hello`.

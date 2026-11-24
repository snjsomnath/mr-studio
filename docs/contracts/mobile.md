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

- See every layer of the table, turn one on or off with its switch (#335), and change its controls marked `phone: true`. A layer's `primary` controls are for phones too unless they say `phone: false`.
  Turning a layer on from a phone closes the open layer, as its button on the controller does. The controller shows a short line, "Wind turned on from a phone", with a dot in that phone's colour.
  Phones cannot switch layers while a slideshow or tour is showing, on a table with `tv.phone_switch: false` (Table settings, "Phones can switch layers"), or for a layer whose layer.json says `"phone_switch": false` (the slideshow does).
- Use a layer's tools: tap a point, draw a line or polygon on a small map of the table area. The result is sent as `tool.input` in WGS84.
  A point is sent on touch and follows a dragged finger. A line or polygon is built corner by corner (with undo) and sent when the person presses send.
  The map shows the site's building footprints and maps finger positions through the site's `corners`, so it needs no map library and no internet.
- Press actions marked `phone: true`.

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

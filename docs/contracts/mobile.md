# Mobile controller contract

The phone UI is a surface like any other. It is served by the studio's own host from the same build as the table, so the phone and table can never be on different versions and no internet is needed.

## Joining

1. The TV shows a QR code for `http://<studio-lan-address>:<port>/phone?c=<code>` (the session's `join_url`), with the address and the code beside it for typing. The code is the session's join code. `/phone` without a code asks for it.
2. The phone opens the page and sends `hello` with `role: 'phone'` and the code.
3. The host assigns a free slot (number and colour) and announces it to every surface.
4. The `welcome` carries a `resume` token. The page keeps it (local storage, per session code) and sends it in every later `hello`.
5. When a phone's connection ends, its slot is held for 60 seconds and shown as away (`connected: false`). A `hello` with the token inside that time returns the phone to the same slot and colour. After 60 seconds the slot is released and the token is worthless.

The host limits the number of phones (default 8) and answers further joins with a "session full" error the page shows. Held slots count as taken.
A phone that goes silent without closing (asleep, out of range) is noticed within 30 seconds, and its hold starts then.
One token is one phone: a second tab with the same token takes the slot over and the first tab is told to stop.

## What a phone can do

- See the active layers and change the controls marked `phone: true`.
- Use a layer's tools: tap a point, draw a line or polygon on a small map of the table area. The result is sent as `tool.input` in WGS84.
  A point is sent on touch and follows a dragged finger. A line or polygon is built corner by corner (with undo) and sent when the person presses send.
  The map shows the site's building footprints and maps finger positions through the site's `corners`, so it needs no map library and no internet.
- Press actions marked `phone: true`.

A phone cannot activate layers, publish values or open engine streams. The host enforces this by role; the page hiding a control is not the protection.

## Limits

- Surfaces coalesce param changes: at most one request per animation frame, carrying the latest values.
- On a phone, repeated requests of one kind (a dragged slider, a dragged point) are spaced at least 80 ms apart.
- The host accepts at most 20 requests per second per phone and refuses the rest with `rate limited`. The limit belongs to the slot, so reconnecting does not reset it.

## Reaching the studio

The default is the local network. Two later additions use the same protocol unchanged:

- **Relay**: for venues where phones cannot reach the studio's network, the host opens an outbound connection to a relay and phones connect to the relay's URL instead.
- **HTTPS**: phone features that need a secure context (camera, motion sensors) require the relay or a local certificate. Plain controls and tools do not.

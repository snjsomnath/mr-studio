# Mobile controller contract

The phone UI is a surface like any other. It is served by the studio's own host from the same build as the table, so the phone and table can never be on different versions and no internet is needed.

## Joining

1. The TV shows a QR code for `http://<studio-lan-address>:<port>/phone?c=<code>`. The code is the session's join code.
2. The phone opens the page and sends `hello` with `role: 'phone'` and the code.
3. The host assigns a free slot (number and colour) and announces it to every surface.
4. A slot is released when its phone disconnects. Planned: a `resume` token so a reload or a brief drop returns to the same slot, with the slot held for 60 seconds.

The host limits the number of phones (default 8) and answers further joins with a "session full" error the page shows.

## What a phone can do

- See the active layers and change the controls marked `phone: true`.
- Use a layer's tools: tap a point, draw a line or polygon on a small map of the table area. The result is sent as `tool.input` in WGS84.
- Press actions marked `phone: true`.

A phone cannot activate layers, publish values or open engine streams. The host enforces this by role; the page hiding a control is not the protection.

## Limits

- Surfaces coalesce param changes: at most one request per animation frame, carrying the latest values.
- Planned: the host accepts at most 20 requests per second per phone and drops the rest.

## Reaching the studio

The default is the local network. Two later additions use the same protocol unchanged:

- **Relay**: for venues where phones cannot reach the studio's network, the host opens an outbound connection to a relay and phones connect to the relay's URL instead.
- **HTTPS**: phone features that need a secure context (camera, motion sensors) require the relay or a local certificate. Plain controls and tools do not.

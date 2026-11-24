# Join page: phones from any network, no server of our own

Phones normally join over the venue's own network: the QR code holds the studio computer's address. Venues without a router of their own, only eduroam (which stops devices seeing each other) and mobile data, make that impossible. The join page fixes it without running anything ourselves (#275).

```
phone ──HTTPS──▶ join page on GitHub Pages (static, the same for every table)
phone ◀──WebRTC data channel──▶ controller window ──local socket──▶ mrs-host
          (PeerJS signalling finds the two; the data goes peer to peer or via TURN)
```

## How a phone joins

1. The controller (or, without one, the table) opens `/api/phones/bridge` on the host and becomes a WebRTC peer with a random id, using the free PeerJS signalling server.
2. The QR code then reads `https://snjsomnath.github.io/mr-studio/v1/?t=<peer>#/phone?c=<code>`. The guide's link works the same way (`#/guide?g=<code>`).
3. The phone opens the join page. It connects to the table's peer and shows the phone page **from the table** in a frame: a service worker hands every request of that frame to the join page, which sends it over the data channel. The frame's WebSocket is carried the same way.
4. The host answers exactly as it answers the relay ([relay.md](relay.md)): as from the network, GET and HEAD only, and every socket must start with a phone's (or the guide's) `hello`. The session code is still needed.

Nothing about a table is published: a table made in the editor an hour ago gets a working QR code the moment it is presented. The phone always runs the table's own version.

The QR code prefers a linked relay, then the join page, then the local address. Without internet the join page cannot link, and the QR code falls back to the local address.

## Versions

The join page and the bridge agree on one number, `LINK_VERSION` (in `packages/sdk/src/link.ts` and `crates/mrs-host/src/bridge.rs`; a host test checks they match, and that `.github/workflows/pages.yml` publishes that version). It is not the app's version: it goes up only when the link's frames or handshake change in a way older tables cannot follow.

- Every merge to `main` republishes the join page (`.github/workflows/pages.yml`).
- Each version's page lives at `/v<N>/` and stays published, so a table running an older app keeps working.
- A join page that meets a table on another version moves to that version's page by itself.

To bump: change `LINK_VERSION` in both files and in `pages.yml`, tag the last commit of the old version `join-v<N>`, and add a step to `pages.yml` that builds that tag into `_site/v<N>`.

## Settings

- `MRS_JOIN_PAGE`: another join page address, or `off` to turn the join page off (the host then tells the controller so, and the QR code uses the local address).
- `MRS_PEER_OPTIONS`: PeerJS options as JSON, such as your own signalling server (`{"host":"peer.example.org","port":443,"secure":true}`) or `{"config":{"iceServers":[…]}}` for a TURN server of your own. They travel to the join page in the QR link.

PeerJS's defaults include Google's STUN server and PeerJS's public TURN servers, which carry the data when the two sides cannot reach each other directly (common on mobile data). Networks that block WebRTC altogether need the relay.

## Publishing on GitHub Pages

The repository's Settings, Pages, Source must be **GitHub Actions** (once). The "Join page" workflow then publishes on every merge to `main`.

## Testing without the internet

```sh
# A PeerJS signalling server (npm i peer), the join page, and the host:
node -e "require('peer').PeerServer({ port: 9000, path: '/', host: '127.0.0.1' })"
pnpm --filter @mrstudio/join build && mkdir -p /tmp/pages/mr-studio && cp -r packages/join/dist /tmp/pages/mr-studio/v1
(cd /tmp/pages && python3 -m http.server 5600 --bind 127.0.0.1)
MRS_JOIN_PAGE=http://localhost:5600/mr-studio/v1/ MRS_PEER_OPTIONS='{"host":"127.0.0.1","port":9000,"path":"/","secure":false}' \
  mrstudio dev --port 4199 --web packages/runtime/dist
```

Open `http://127.0.0.1:4199/tv`, then the QR link in another browser. `/bridge` is the bridge alone, with nothing drawn, for scripts. Headless Chromium needs `--disable-features=WebRtcHideLocalIpsWithMdns`.

## Limits

- The controller (or table) window must stay open and in front: it carries the phones. Its page handles their requests between frames. In the app that is the controller window on the TV. In a browser tab it is fragile: a closed tab, or a browser putting a background tab to sleep, drops every phone (seen in the first real-phone test).
- Each phone loads the phone page (about 0.5 MB) through the link when it joins.
- Tried on a real phone on mobile data (2026-11-24): it worked. Eduroam is not tried yet (#89).

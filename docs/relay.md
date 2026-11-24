# Phone relay

Phones normally join the table over the venue's own network: the QR code holds the studio computer's address. Some venues make that impossible. Guest Wi-Fi often stops devices from seeing each other, and visitors on mobile data are on another network altogether. The [join page](join-page.md) fixes both without a server of our own, and is the default. A relay fixes both too, for networks that block WebRTC. It is a small server on the internet that the studio computer connects out to, so nothing has to reach in.

```
phone ──HTTPS──▶ relay ◀──WSS── studio computer (mrs-host)
```

While the studio is linked, the QR code points at the relay (`https://relay.example.org/r/<room>/phone?c=<code>`). The room is a random name for that run of the studio, and the session code is still needed to join.

## What gets through

The relay passes on phones' page loads and their session socket, and nothing else.

- The host answers relayed requests as if they came from the network, never from the studio computer. Sources, keys, settings and every other route that only the computer may use refuse them.
- Only GET and HEAD requests pass. A socket through the relay must start with a phone's `hello`; a table, controller or editor cannot join that way.
- The host link needs a token. A relay without tokens accepts no studios.
- The relay keeps nothing. It forgets a room when its studio disconnects.

## Running a relay

The relay is one program, `mrs-relay`, built from this repository (`cargo build --release -p mrs-relay`). It listens on plain HTTP and expects a proxy in front of it for HTTPS.

```sh
MRS_RELAY_TOKENS="long-random-token-one,long-random-token-two" mrs-relay --bind 127.0.0.1:8080
```

- `MRS_RELAY_TOKENS`: comma-separated tokens, at least 16 characters each. Give each studio its own, so one can be withdrawn alone.
- `--bind`: the address to listen on (default `0.0.0.0:8080`).
- `--insecure-cookies`: only for testing over plain HTTP. Without it the room cookie is marked `Secure`.

A [Caddy](https://caddyserver.com) site in front gets the certificate by itself:

```
relay.example.org {
    reverse_proxy 127.0.0.1:8080
}
```

`GET /health` answers `ok` and is what the studio's **Test** button checks.

## Linking the studio

In the studio app, open **Sources and keys**, add **Phone relay**, and enter the relay's address (`https://relay.example.org`) and its token. The studio links on its next start and keeps trying, with growing pauses, whenever the link drops. While it is not linked the QR code falls back to the local network address.

For development, the CLI links to a relay directly:

```sh
MRS_RELAY_TOKEN=long-random-token-one mrstudio dev --relay http://127.0.0.1:8080
```

## Limits

- Each request or response body is at most 64 MB, and a request waits at most 30 seconds for the studio.
- At most 512 requests wait at once in one room.
- One studio per room: a studio that links with a room name already in use replaces the old link.

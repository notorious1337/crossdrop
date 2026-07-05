# CrossDrop — "AirDrop for Everyone"

Send files between any two devices — Android, iPhone, Windows, Mac — instantly, at full quality, with no login and no app install. Files travel **peer-to-peer over an encrypted WebRTC DataChannel**; they never touch a server.

```
crossdrop/
├── site/                 Astro marketing site + the WebRTC transfer island
│   ├── src/pages/        /, /how-it-works, /faq, /vs-airdrop, /privacy
│   ├── src/components/   Transfer.astro (the only interactive island)
│   ├── src/islands/transfer/
│   │   ├── main.js       UI orchestration + connection-state machine
│   │   ├── rtc.js        signaling client + RTCPeerConnection/DataChannel
│   │   ├── protocol.js   file chunking, backpressure, progress, save
│   │   └── qr.js         QR generation (qrcode) + scanning (BarcodeDetector / jsQR)
│   └── public/           manifest.webmanifest, robots.txt, icons, OG image
└── signaling-server/     Node WebSocket server — relays SDP/ICE only
    └── server.js
```

## Run locally

Two terminals:

```bash
# 1) Signaling server (ws://localhost:8787)
cd signaling-server
npm install
npm start

# 2) Astro site (http://localhost:4321)
cd site
npm install
npm run dev
```

Open http://localhost:4321 on two devices/browsers. To test across real devices on your Wi-Fi, run `npm run dev -- --host` and set `PUBLIC_SIGNALING_URL` (see `site/.env.example`) to `ws://<your-lan-ip>:8787`.

> **Note on camera/QR scanning:** browsers require a secure context for `getUserMedia`. `localhost` counts; a LAN IP does not. On LAN, type the room code manually, or serve over HTTPS (e.g. Caddy, or a tunnel like `cloudflared`).

## Signaling message protocol

JSON over a single WebSocket. The server pairs two sockets into a room and relays opaque WebRTC payloads. It never sees file data.

| Direction | Message | Meaning |
|---|---|---|
| C → S | `{ "type": "create" }` | Request a new room |
| S → C | `{ "type": "created", "room": "swift-otter-42" }` | Room code assigned |
| C → S | `{ "type": "join", "room": "swift-otter-42" }` | Join as second peer |
| S → C | `{ "type": "joined", "room": "…" }` | Sent to the joiner |
| S → C | `{ "type": "peer-joined" }` | Sent to the creator → it makes the SDP offer |
| C → S | `{ "type": "signal", "data": { "sdp": … } }` or `{ "data": { "candidate": … } }` | Relayed verbatim to the other peer |
| S → C | `{ "type": "signal", "data": … }` | The relayed payload |
| C → S | `{ "type": "leave" }` | Leave (implied by socket close) |
| S → C | `{ "type": "peer-left" }` | Other device left; room destroyed |
| S → C | `{ "type": "error", "code": "…", "message": "…" }` | `room-not-found` \| `room-full` \| `not-in-room` \| `bad-message` |

Rooms: max 2 peers, single-use, 10-minute TTL if pairing never completes, destroyed on first disconnect.

## File transfer protocol (over the DataChannel)

Ordered + reliable channel. Control messages are JSON strings; file bytes are raw `ArrayBuffer`s (in-order delivery ⇒ no chunk indexes needed).

```
sender → receiver   { t:'meta', id, name, size, mime }
receiver → sender   { t:'go', id }        ← lets receiver open a disk stream first
sender → receiver   <ArrayBuffer> × N     64 KB chunks
sender → receiver   { t:'eof', id }
```

- **Backpressure:** sends pause when `bufferedAmount` > 4 MB and resume on `bufferedamountlow` (threshold 1 MB).
- **Big files:** above 256 MB, browsers with the File System Access API offer "Choose save location" and stream chunks to disk instead of buffering in memory. Elsewhere, files buffer and save via a download link.
- **Speed/ETA:** rolling 3-second window of byte samples.

## Deployment

- **Astro site** → any static host (Vercel, Netlify, Cloudflare Pages). Build with `npm run build` in `site/`; output is `site/dist/`. Set the env var `PUBLIC_SIGNALING_URL=wss://your-signaling-host` at build time, and update `site` in `astro.config.mjs` to your real domain (drives canonicals + sitemap).
- **Signaling server** → any small Node host (Fly.io, Railway, Render, a $5 VPS). It's stateless apart from in-memory rooms, so a single tiny instance is plenty. Put it behind TLS (`wss://`) — browsers on an HTTPS page can't open `ws://`.
- **TURN (optional fallback):** for symmetric NATs / client-isolated networks, run coturn and add its credentials to `ICE_SERVERS` in `site/src/islands/transfer/rtc.js`. No other changes needed.
- **OG image:** `public/og-image.svg` is a placeholder — some platforms (notably Twitter/X) won't render SVG previews, so export it to a 1200×630 PNG before launch and update `Base.astro`'s default.

## SEO checklist (already wired)

- Static-first Astro pages; the WebRTC widget is the only client-side island
- Title/description/canonical/OG/Twitter tags on every page (`Base.astro`)
- JSON-LD: `SoftwareApplication` + `FAQPage` (home), `FAQPage` (/faq), `BreadcrumbList` (inner pages)
- `@astrojs/sitemap` → `sitemap-index.xml`, referenced from `robots.txt`
- Semantic headings, alt/aria labels, WCAG-minded focus states, `prefers-reduced-motion` respected

**After launch:** submit the sitemap in Google Search Console, watch Core Web Vitals in PageSpeed Insights, and build out `/blog/*` pages targeting: "AirDrop alternative for Android", "How to send files from iPhone to Windows", "Transfer photos without losing quality", "Send large files without email attachment limits".

## Benchmarks worth running

1. **Pairing reliability** across real combos (iPhone↔Android, Windows↔Mac, iPhone↔Mac) on different routers — especially ones with AP/client isolation, which blocks local WebRTC discovery. The UI already surfaces a "same Wi-Fi" hint on ICE failure.
2. **Chunk size vs throughput** on real Wi-Fi (not localhost): try 16/32/64/128 KB in `protocol.js` (`CHUNK_SIZE`) and watch the live MB/s readout. Safari has historically been the most quirky DataChannel implementation — test it first.

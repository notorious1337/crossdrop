/** FAQ content — rendered on the landing page and /faq, and emitted as
 *  FAQPage JSON-LD for rich snippets. Keep answers plain-text friendly. */
export const faqs = [
  {
    q: 'Does CrossDrop compress my photos and videos?',
    a: 'No. Files are sent byte-for-byte over a direct connection between your two devices. There is no recompression, resizing, or format conversion — the receiver gets an identical copy of the original file.',
  },
  {
    q: 'Do I need to install an app or create an account?',
    a: 'No. CrossDrop runs entirely in the browser on both devices. There are no accounts, no logins, and no personal data to hand over. Open the site, pair with a QR code or room code, and send.',
  },
  {
    q: 'How do I send files from an iPhone to an Android phone (or Windows to Mac)?',
    a: 'Open CrossDrop on both devices while they are on the same Wi-Fi network. One device shows a QR code and room code; the other scans the code or types it in. Once connected, pick your files and they transfer directly between the two devices.',
  },
  {
    q: 'Are my files uploaded to a server?',
    a: 'Never. Files travel peer-to-peer over an encrypted WebRTC connection between your two devices. Our small pairing server only helps the devices find each other — it never sees, stores, or relays your files.',
  },
  {
    q: 'Is the transfer encrypted?',
    a: 'Yes, by design. WebRTC connections are always encrypted in transit with DTLS — it is mandatory in the protocol, not an optional add-on.',
  },
  {
    q: 'Do both devices need to be on the same Wi-Fi?',
    a: 'For the fastest transfers, yes — on the same network, files move at local Wi-Fi speed instead of being limited by your internet connection. Devices on different networks can often still connect directly; if pairing fails, joining the same Wi-Fi almost always fixes it.',
  },
  {
    q: 'Is there a file size limit?',
    a: 'No hard limit is imposed by CrossDrop. Very large files are streamed in small chunks; in supporting browsers, the receiver can save huge files straight to disk as they arrive instead of holding them in memory.',
  },
  {
    q: 'Why does pairing fail on some networks?',
    a: 'Some routers (often guest or hotel networks) enable AP/client isolation, which blocks devices on the same Wi-Fi from talking to each other. Try a different network or a phone hotspot — both devices connected to the same hotspot works reliably.',
  },
];

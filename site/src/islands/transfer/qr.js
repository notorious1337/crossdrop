/**
 * QR pairing helpers — everything runs in the browser, no server round-trip.
 *   drawQr(canvas, text)  render a join URL as a QR code
 *   QrScanner             camera-based scanner: native BarcodeDetector
 *                         where available, jsQR (wasm-free JS) elsewhere
 */

import QRCode from 'qrcode';
import jsQR from 'jsqr';

export async function drawQr(canvas, text) {
  await QRCode.toCanvas(canvas, text, {
    width: 220,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#131c26', light: '#ffffff' },
  });
}

export class QrScanner {
  constructor(videoEl, onResult) {
    this.video = videoEl;
    this.onResult = onResult;
    this.running = false;
    this.detector =
      'BarcodeDetector' in window
        ? new window.BarcodeDetector({ formats: ['qr_code'] })
        : null;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.running = true;

    if (!this.detector) {
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }
    this.tick();
  }

  async tick() {
    if (!this.running) return;
    try {
      let value = null;

      if (this.detector) {
        const codes = await this.detector.detect(this.video);
        if (codes.length) value = codes[0].rawValue;
      } else if (this.video.videoWidth) {
        const w = (this.canvas.width = this.video.videoWidth);
        const h = (this.canvas.height = this.video.videoHeight);
        this.ctx.drawImage(this.video, 0, 0, w, h);
        const img = this.ctx.getImageData(0, 0, w, h);
        const code = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
        if (code?.data) value = code.data;
      }

      if (value) {
        this.stop();
        this.onResult(value);
        return;
      }
    } catch {
      /* transient decode errors are fine — keep scanning */
    }
    setTimeout(() => this.tick(), 150);
  }

  stop() {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.video.srcObject = null;
  }
}

/** Extract a room code from scanned text — accepts either a bare code
 *  ("swift-otter-42") or a full join URL ("https://…/?join=swift-otter-42"). */
export function parseRoomCode(text) {
  const trimmed = text.trim();
  try {
    const url = new URL(trimmed);
    const fromParam = url.searchParams.get('join');
    if (fromParam) return fromParam.toLowerCase();
  } catch {
    /* not a URL — treat as a bare code */
  }
  const m = trimmed.toLowerCase().match(/[a-z]+-[a-z]+-\d+/);
  return m ? m[0] : trimmed.toLowerCase();
}

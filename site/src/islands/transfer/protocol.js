/**
 * File transfer protocol over an ordered, reliable RTCDataChannel.
 *
 * Wire format
 * -----------
 * Control messages are JSON strings; file bytes are raw ArrayBuffers.
 * Because the channel is ordered + reliable, binary chunks arrive in
 * exactly the sequence they were sent — no chunk indexes needed.
 *
 *   { t: 'meta', id, name, size, mime }   sender → receiver, per file
 *   { t: 'go',   id }                     receiver → sender: start streaming
 *                                         (lets the receiver set up a disk
 *                                         stream for huge files first)
 *   <ArrayBuffer> × N                     the file body, in order
 *   { t: 'eof',  id }                     sender → receiver, per file
 *
 * Throughput
 * ----------
 * CHUNK_SIZE of 64 KB is a safe cross-browser message size and a good
 * starting point on LAN — tune against real Wi-Fi (see README §Benchmarks).
 * Backpressure: writes pause while bufferedAmount exceeds HIGH_WATER and
 * resume on the `bufferedamountlow` event, keeping the pipe full without
 * ballooning memory.
 */

const CHUNK_SIZE = 64 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;  // pause sends above 4 MB buffered
const LOW_WATER = 1 * 1024 * 1024;   // resume once it drains below 1 MB

/** Threshold above which the receiver is offered a streamed save-to-disk
 *  via the File System Access API instead of buffering in memory. */
export const BIG_FILE_BYTES = 256 * 1024 * 1024;

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatEta(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.ceil(seconds % 60);
  return `${m}m ${s}s`;
}

/** Rolling-window transfer speed (bytes/sec over the last ~3 seconds). */
export class SpeedMeter {
  constructor(windowMs = 3000) {
    this.windowMs = windowMs;
    this.samples = [];
  }
  add(bytes) {
    const now = performance.now();
    this.samples.push({ t: now, b: bytes });
    const cutoff = now - this.windowMs;
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
  }
  bytesPerSec() {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (dt <= 0) return 0;
    const total = this.samples.slice(1).reduce((sum, s) => sum + s.b, 0);
    return total / dt;
  }
}

let nextId = 1;

export class FileTransfer {
  /**
   * @param {RTCDataChannel} channel
   * @param {object} hooks
   *   onIncoming(file)        meta received; file = {id, name, size, mime}
   *   onProgress(p)           {id, name, dir:'send'|'recv', sent, size, bps, eta}
   *   onComplete(f)           {id, name, size, dir, blobUrl?, savedToDisk?}
   *   onError(message)
   */
  constructor(channel, hooks) {
    this.channel = channel;
    this.hooks = hooks;
    this.sendQueue = [];
    this.sending = false;
    this.pendingGo = new Map();   // id -> resolve()
    this.incoming = null;         // current file being received
    channel.bufferedAmountLowThreshold = LOW_WATER;
    channel.addEventListener('message', (e) => this.onMessage(e));
  }

  sendJson(obj) { this.channel.send(JSON.stringify(obj)); }

  /* ------------------------------ sending ----------------------------- */

  /** Queue files for sending. Returns the assigned {id, file} items so the
   *  UI can render rows before streaming begins. */
  enqueue(files) {
    const items = Array.from(files, (file) => ({ id: nextId++, file }));
    this.sendQueue.push(...items);
    if (!this.sending) this.drainQueue();
    return items;
  }

  async drainQueue() {
    this.sending = true;
    try {
      while (this.sendQueue.length) {
        const item = this.sendQueue.shift();
        await this.sendOne(item);
      }
    } catch (err) {
      this.hooks.onError?.(`Transfer failed: ${err.message}`);
    } finally {
      this.sending = false;
    }
  }

  async sendOne({ id, file }) {
    this.sendJson({
      t: 'meta', id,
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
    });

    // Wait for the receiver's green light (it may open a save dialog).
    await new Promise((resolve) => this.pendingGo.set(id, resolve));
    this.pendingGo.delete(id);

    const meter = new SpeedMeter();
    let sent = 0;
    let offset = 0;

    while (offset < file.size) {
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      const buf = await slice.arrayBuffer();
      await this.waitForDrain();
      if (this.channel.readyState !== 'open') throw new Error('Connection closed');
      this.channel.send(buf);
      offset += buf.byteLength;
      sent += buf.byteLength;
      meter.add(buf.byteLength);
      const bps = meter.bytesPerSec();
      this.hooks.onProgress?.({
        id, name: file.name, dir: 'send',
        sent, size: file.size, bps,
        eta: bps > 0 ? (file.size - sent) / bps : Infinity,
      });
    }

    this.sendJson({ t: 'eof', id });
    this.hooks.onComplete?.({ id, name: file.name, size: file.size, dir: 'send' });
  }

  waitForDrain() {
    if (this.channel.bufferedAmount <= HIGH_WATER) return Promise.resolve();
    return new Promise((resolve) => {
      const onLow = () => {
        this.channel.removeEventListener('bufferedamountlow', onLow);
        resolve();
      };
      this.channel.addEventListener('bufferedamountlow', onLow);
    });
  }

  /* ----------------------------- receiving ---------------------------- */

  async onMessage(event) {
    const { data } = event;

    if (typeof data === 'string') {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.t === 'meta') return this.onMeta(msg);
      if (msg.t === 'go') return this.pendingGo.get(msg.id)?.();
      if (msg.t === 'eof') return this.onEof(msg);
      return;
    }

    // Binary chunk (ArrayBuffer; Blob on some older Safari versions)
    const buf = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
    const f = this.incoming;
    if (!f) return;

    if (f.writer) {
      await f.writer.write(new Uint8Array(buf));
    } else {
      f.chunks.push(buf);
    }
    f.received += buf.byteLength;
    f.meter.add(buf.byteLength);
    const bps = f.meter.bytesPerSec();
    this.hooks.onProgress?.({
      id: f.id, name: f.name, dir: 'recv',
      sent: f.received, size: f.size, bps,
      eta: bps > 0 ? (f.size - f.received) / bps : Infinity,
    });
  }

  async onMeta(msg) {
    const file = {
      id: msg.id, name: msg.name, size: msg.size, mime: msg.mime,
      chunks: [], received: 0, meter: new SpeedMeter(), writer: null,
    };
    this.incoming = file;
    this.hooks.onIncoming?.(file);

    // Big file + File System Access API available → let the UI ask the
    // user where to stream it, so it never sits fully in memory.
    if (msg.size > BIG_FILE_BYTES && 'showSaveFilePicker' in window) {
      // The UI calls transfer.acceptToDisk(id) or transfer.acceptToMemory(id).
      return;
    }
    this.acceptToMemory(msg.id);
  }

  /** Buffer in memory; offered as a download link when complete. */
  acceptToMemory(id) {
    if (this.incoming?.id !== id) return;
    this.sendJson({ t: 'go', id });
  }

  /** Stream straight to disk via showSaveFilePicker (user gesture required). */
  async acceptToDisk(id) {
    const f = this.incoming;
    if (f?.id !== id) return;
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: f.name });
      f.writer = await handle.createWritable();
      this.sendJson({ t: 'go', id });
    } catch (err) {
      if (err?.name === 'AbortError') {
        // User cancelled the picker — fall back to memory buffering.
        this.acceptToMemory(id);
      } else {
        this.hooks.onError?.(`Couldn\u2019t open a save location: ${err.message}`);
      }
    }
  }

  async onEof(msg) {
    const f = this.incoming;
    if (!f || f.id !== msg.id) return;
    this.incoming = null;

    if (f.writer) {
      await f.writer.close();
      this.hooks.onComplete?.({
        id: f.id, name: f.name, size: f.size, dir: 'recv', savedToDisk: true,
      });
    } else {
      const blob = new Blob(f.chunks, { type: f.mime });
      f.chunks = [];
      const blobUrl = URL.createObjectURL(blob);
      this.hooks.onComplete?.({
        id: f.id, name: f.name, size: f.size, dir: 'recv', blobUrl,
      });
    }
  }
}

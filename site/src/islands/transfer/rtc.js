/**
 * PeerSession — owns the WebSocket signaling connection and the
 * RTCPeerConnection. Emits high-level events the UI can render.
 *
 * Roles:
 *   - "host":  created the room, creates the DataChannel, sends the offer
 *   - "guest": joined via code/QR, answers the offer
 *
 * ICE servers: on the same Wi-Fi, host candidates usually connect
 * directly without STUN ever being consulted. STUN covers cross-subnet
 * cases. A TURN relay can be added to ICE_SERVERS below as a fallback
 * for symmetric NATs / client-isolated networks — architecture supports
 * it, no other code changes needed.
 */

const SIGNALING_URL =
  import.meta.env.PUBLIC_SIGNALING_URL || 'ws://localhost:8787';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  // TURN fallback plugs in here, e.g.:
  // { urls: 'turn:turn.example.com:3478', username: '...', credential: '...' },
];

export class PeerSession extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.pc = null;
    this.channel = null;
    this.role = null;
    this.room = null;
    this.closed = false;
    this.channelOpen = false;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** Connect to the signaling server. Resolves when the socket is open. */
  connectSignaling() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(SIGNALING_URL);
      this.ws = ws;
      const fail = () =>
        reject(new Error('Could not reach the pairing server.'));
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', fail, { once: true });
      ws.addEventListener('close', () => {
        if (!this.closed && !this.channelOpen) {
          this.emit('error', {
            message: 'Lost connection to the pairing server.',
          });
        }
      });
      ws.addEventListener('message', (e) => this.onSignal(e));
    });
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** Create a room as host. Emits `room` with the code. */
  async host() {
    this.role = 'host';
    await this.connectSignaling();
    this.send({ type: 'create' });
  }

  /** Join an existing room as guest. */
  async join(code) {
    this.role = 'guest';
    await this.connectSignaling();
    this.send({ type: 'join', room: code });
  }

  async onSignal(event) {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    switch (msg.type) {
      case 'created':
        this.room = msg.room;
        this.emit('room', { room: msg.room });
        break;

      case 'joined':
        this.room = msg.room;
        this.emit('state', { state: 'connecting' });
        this.setupPeer(); // guest waits for the host's offer
        break;

      case 'peer-joined':
        this.emit('state', { state: 'connecting' });
        this.setupPeer();
        await this.makeOffer(); // host drives negotiation
        break;

      case 'signal':
        await this.handleRemoteSignal(msg.data);
        break;

      case 'peer-left':
        this.emit('peer-left', {});
        break;

      case 'error':
        this.emit('error', { code: msg.code, message: msg.message });
        break;
    }
  }

  setupPeer() {
    if (this.pc) return;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;

    pc.addEventListener('icecandidate', (e) => {
      if (e.candidate) {
        this.send({ type: 'signal', data: { candidate: e.candidate } });
      }
    });

    pc.addEventListener('connectionstatechange', () => {
      const s = pc.connectionState;
      if (s === 'failed') {
        this.emit('error', {
          code: 'ice-failed',
          message:
            'Couldn\u2019t connect the two devices directly. Make sure both are on the same Wi-Fi network, then try a new room.',
        });
      } else if (s === 'disconnected' || s === 'closed') {
        if (!this.closed) this.emit('peer-left', {});
      }
    });

    if (this.role === 'host') {
      // ordered + reliable (defaults): in-order chunk delivery keeps
      // reassembly trivial, and LAN speeds make the overhead irrelevant.
      const ch = pc.createDataChannel('crossdrop', { ordered: true });
      this.wireChannel(ch);
    } else {
      pc.addEventListener('datachannel', (e) => this.wireChannel(e.channel));
    }
  }

  wireChannel(channel) {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.addEventListener('open', () => {
      this.channelOpen = true;
      this.emit('channel-open', { channel });
      // Handshake done — the signaling socket has served its purpose.
      // Keep it open briefly for trickle ICE stragglers, then drop it.
      setTimeout(() => this.ws?.close(), 3000);
    });
    channel.addEventListener('close', () => {
      if (!this.closed) this.emit('peer-left', {});
    });
  }

  async makeOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.send({ type: 'signal', data: { sdp: this.pc.localDescription } });
  }

  async handleRemoteSignal(data) {
    if (!this.pc) this.setupPeer();
    try {
      if (data.sdp) {
        await this.pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          this.send({ type: 'signal', data: { sdp: this.pc.localDescription } });
        }
      } else if (data.candidate) {
        await this.pc.addIceCandidate(data.candidate);
      }
    } catch (err) {
      console.error('Signaling error', err);
    }
  }

  close() {
    this.closed = true;
    try { this.send({ type: 'leave' }); } catch { /* noop */ }
    this.ws?.close();
    this.channel?.close();
    this.pc?.close();
  }
}

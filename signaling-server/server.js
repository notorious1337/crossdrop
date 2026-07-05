/**
 * CrossDrop signaling server
 * ---------------------------------------------------------------
 * Purpose: pair exactly two browsers into a "room" and relay their
 * WebRTC handshake messages (SDP offers/answers + ICE candidates).
 * It NEVER sees, stores, or relays file data — files travel directly
 * between the two peers over an encrypted WebRTC DataChannel.
 *
 * Message protocol (JSON over WebSocket)
 * ---------------------------------------------------------------
 * Client → Server
 *   { "type": "create" }
 *       Ask for a new room. Server replies with `created`.
 *   { "type": "join", "room": "swift-otter-42" }
 *       Join an existing room as the second peer.
 *   { "type": "signal", "data": { ... } }
 *       Opaque WebRTC payload (an SDP description or an ICE
 *       candidate). Relayed verbatim to the other peer in the room.
 *   { "type": "leave" }
 *       Politely leave the room (also implied by socket close).
 *
 * Server → Client
 *   { "type": "created", "room": "swift-otter-42" }
 *   { "type": "joined",  "room": "swift-otter-42" }   // to the joiner
 *   { "type": "peer-joined" }                          // to the creator
 *   { "type": "signal", "data": { ... } }              // relayed payload
 *   { "type": "peer-left" }
 *   { "type": "error", "code": "room-not-found" | "room-full" |
 *                              "not-in-room" | "bad-message",
 *     "message": "human readable" }
 *
 * Rooms hold at most 2 peers, expire after 10 minutes if pairing
 * never completes, and are deleted the moment either peer leaves.
 * Nothing is written to disk and nothing is logged beyond counts.
 */

import { WebSocketServer } from 'ws';
import { randomInt } from 'node:crypto';

const PORT = process.env.PORT || 8787;
const ROOM_TTL_MS = 10 * 60 * 1000; // unpaired rooms expire after 10 min
const MAX_MSG_BYTES = 64 * 1024;    // signaling messages are tiny; cap hard

// Human-readable room codes: adjective-animal-number, e.g. swift-otter-42
const ADJECTIVES = [
  'swift', 'quiet', 'brave', 'sunny', 'lucky', 'calm', 'bright', 'rapid',
  'gentle', 'bold', 'clever', 'cosmic', 'crisp', 'eager', 'fuzzy', 'golden',
  'happy', 'icy', 'jolly', 'keen', 'lively', 'mellow', 'noble', 'polar',
  'quick', 'royal', 'silent', 'tidal', 'urban', 'vivid', 'wild', 'zesty',
];
const ANIMALS = [
  'otter', 'falcon', 'panda', 'lynx', 'heron', 'badger', 'dolphin', 'ibex',
  'jaguar', 'koala', 'lemur', 'marten', 'narwhal', 'ocelot', 'puffin',
  'quokka', 'raven', 'seal', 'tapir', 'urchin', 'viper', 'walrus', 'yak',
  'zebra', 'bison', 'condor', 'dingo', 'egret', 'ferret', 'gecko',
];

/** rooms: code -> { peers: Set<ws>, createdAt: number } */
const rooms = new Map();

function makeRoomCode() {
  for (let i = 0; i < 50; i++) {
    const code = [
      ADJECTIVES[randomInt(ADJECTIVES.length)],
      ANIMALS[randomInt(ANIMALS.length)],
      randomInt(10, 100),
    ].join('-');
    if (!rooms.has(code)) return code;
  }
  // Astronomically unlikely fallback
  return `room-${randomInt(1e9)}`;
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function sendError(ws, code, message) {
  send(ws, { type: 'error', code, message });
}

function otherPeer(room, ws) {
  for (const peer of room.peers) if (peer !== ws) return peer;
  return null;
}

function leaveRoom(ws) {
  const code = ws.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  ws.roomCode = null;
  if (!room) return;
  room.peers.delete(ws);
  // A room is single-use: once anyone leaves, tear it down and tell
  // the remaining peer so its UI can show a clear "peer left" state.
  for (const peer of room.peers) {
    peer.roomCode = null;
    send(peer, { type: 'peer-left' });
  }
  rooms.delete(code);
}

const wss = new WebSocketServer({ port: PORT, maxPayload: MAX_MSG_BYTES });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.roomCode = null;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return sendError(ws, 'bad-message', 'Messages must be JSON.');
    }

    switch (msg.type) {
      case 'create': {
        leaveRoom(ws); // a socket can only be in one room
        const code = makeRoomCode();
        rooms.set(code, { peers: new Set([ws]), createdAt: Date.now() });
        ws.roomCode = code;
        send(ws, { type: 'created', room: code });
        break;
      }

      case 'join': {
        const code = String(msg.room || '').trim().toLowerCase();
        const room = rooms.get(code);
        if (!room) {
          return sendError(ws, 'room-not-found',
            'That code doesn\u2019t match an open room. Codes expire after 10 minutes.');
        }
        if (room.peers.size >= 2) {
          return sendError(ws, 'room-full', 'This room already has two devices.');
        }
        leaveRoom(ws);
        room.peers.add(ws);
        ws.roomCode = code;
        send(ws, { type: 'joined', room: code });
        const creator = otherPeer(room, ws);
        if (creator) send(creator, { type: 'peer-joined' });
        break;
      }

      case 'signal': {
        const room = rooms.get(ws.roomCode);
        if (!room) return sendError(ws, 'not-in-room', 'Join a room first.');
        const peer = otherPeer(room, ws);
        if (peer) send(peer, { type: 'signal', data: msg.data });
        break;
      }

      case 'leave':
        leaveRoom(ws);
        break;

      default:
        sendError(ws, 'bad-message', `Unknown message type: ${msg.type}`);
    }
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
});

// Heartbeat: drop dead sockets so rooms free up promptly.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

// Expire rooms that never completed pairing.
const reaper = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.peers.size < 2 && now - room.createdAt > ROOM_TTL_MS) {
      for (const peer of room.peers) {
        sendError(peer, 'room-not-found', 'Room expired. Create a new one.');
        peer.roomCode = null;
      }
      rooms.delete(code);
    }
  }
}, 60_000);

wss.on('close', () => { clearInterval(heartbeat); clearInterval(reaper); });

console.log(`CrossDrop signaling server listening on ws://0.0.0.0:${PORT}`);
console.log('This server only relays WebRTC handshakes. File data never passes through it.');

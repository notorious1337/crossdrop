/**
 * Transfer island — wires PeerSession + FileTransfer + QR helpers to the DOM.
 *
 * Connection-state machine (mirrored in the beam UI):
 *   waiting → connecting → connected → transferring → done
 *                              ↘ error (with a human-readable reason)
 */

import { PeerSession } from './rtc.js';
import { FileTransfer, BIG_FILE_BYTES, formatBytes, formatEta } from './protocol.js';
import { drawQr, QrScanner, parseRoomCode } from './qr.js';

const STATUS_TEXT = {
  waiting: 'Waiting for peer — open this on your other device',
  connecting: 'Connecting…',
  connected: 'Connected — pick files to send',
  transferring: 'Transferring…',
  done: 'Done — all transfers complete',
  error: 'Connection problem',
};

export function initTransfer() {
  const root = document.getElementById('transfer-app');
  if (!root) return;

  const $ = (sel) => root.querySelector(sel);
  const panels = root.querySelectorAll('[data-panel]');
  const beam = $('.beam');
  const statusEl = $('#conn-status');
  const roomCodeEl = $('#room-code');
  const qrCanvas = $('#qr-canvas');
  const copyBtn = $('#copy-link');
  const joinInput = $('#join-input');
  const joinBtn = $('#join-btn');
  const scanBtn = $('#scan-btn');
  const scanVideo = $('#scan-video');
  const scanCancel = $('#scan-cancel');
  const dropZone = $('#drop-zone');
  const fileInput = $('#file-input');
  const folderInput = $('#folder-input');
  const fileList = $('#file-list');
  const liveStats = $('#live-stats');
  const errorMsg = $('#error-msg');
  const restartBtn = $('#restart-btn');

  let session = null;
  let transfer = null;
  let scanner = null;
  let joinUrl = '';
  let activeCount = 0;

  function showPanel(name) {
    panels.forEach((p) => (p.hidden = p.dataset.panel !== name));
  }

  function setState(state, statusOverride) {
    beam.dataset.state = state;
    statusEl.textContent = statusOverride || STATUS_TEXT[state] || state;
  }

  function onChannelOpen(channel) {
    transfer = new FileTransfer(channel, transferHooks);
    setState('connected');
    showPanel('connected');
  }

  /* ------------------------------ pairing ------------------------------ */

  function start() {
    session = new PeerSession();

    session.addEventListener('room', (e) => {
      const code = e.detail.room;
      joinUrl = `${location.origin}${location.pathname}?join=${code}`;
      roomCodeEl.textContent = code;
      drawQr(qrCanvas, joinUrl).catch(() => {});
      setState('waiting');
    });

    session.addEventListener('state', (e) => setState(e.detail.state));
    session.addEventListener('channel-open', (e) => onChannelOpen(e.detail.channel));

    session.addEventListener('peer-left', () => {
      if (activeCount > 0) {
        fail('The other device disconnected mid-transfer. Start a new room to try again.');
      } else if (beam.dataset.state === 'connected' || beam.dataset.state === 'done') {
        setState('done', 'The other device left. Start a new room to send more.');
      } else {
        fail('The other device disconnected.');
      }
    });

    session.addEventListener('error', (e) => {
      fail(e.detail.message || 'Something went wrong while pairing.');
    });

    const joinCode = new URLSearchParams(location.search).get('join');
    if (joinCode) {
      // Arrived via a scanned QR / shared link — join immediately.
      history.replaceState(null, '', location.pathname);
      setState('connecting', `Joining ${joinCode}…`);
      showPanel('joining');
      session.join(joinCode).catch((err) => fail(err.message));
    } else {
      setState('connecting', 'Creating your room…');
      showPanel('setup');
      session.host().catch(() =>
        fail(
          'Couldn\u2019t reach the pairing server. Check that it\u2019s running, then try again.'
        )
      );
    }
  }

  function fail(message) {
    setState('error');
    errorMsg.textContent = message;
    showPanel('error');
    scanner?.stop();
  }

  function restart() {
    session?.close();
    transfer = null;
    activeCount = 0;
    rows.clear();
    fileList.innerHTML = '';
    liveStats.textContent = '';
    joinInput.value = '';
    start();
  }

  /* --------------------------- join by code ---------------------------- */

  function startAsGuest(code) {
    session?.close();
    session = new PeerSession();
    session.addEventListener('state', (e) => setState(e.detail.state));
    session.addEventListener('channel-open', (e) => onChannelOpen(e.detail.channel));
    session.addEventListener('peer-left', () => fail('The other device disconnected.'));
    session.addEventListener('error', (e) =>
      fail(e.detail.message || 'Couldn\u2019t join that room.')
    );
    setState('connecting', `Joining ${code}…`);
    showPanel('joining');
    session.join(code).catch((err) => fail(err.message));
  }

  function joinFromInput() {
    const code = parseRoomCode(joinInput.value);
    if (!code) return;
    startAsGuest(code);
  }

  joinBtn.addEventListener('click', joinFromInput);
  joinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinFromInput();
  });

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(joinUrl);
      copyBtn.textContent = 'Link copied';
      setTimeout(() => (copyBtn.textContent = 'Copy join link'), 1800);
    } catch {
      copyBtn.textContent = joinUrl;
    }
  });

  /* ------------------------------ QR scan ------------------------------ */

  scanBtn.addEventListener('click', async () => {
    showPanel('scan');
    scanner = new QrScanner(scanVideo, (text) => {
      const code = parseRoomCode(text);
      showPanel('setup');
      if (code) startAsGuest(code);
    });
    try {
      await scanner.start();
    } catch {
      showPanel('setup');
      fail(
        'Couldn\u2019t open the camera. Type the room code from the other device instead.'
      );
    }
  });

  scanCancel.addEventListener('click', () => {
    scanner?.stop();
    showPanel('setup');
  });

  restartBtn.addEventListener('click', restart);

  /* --------------------------- file handling --------------------------- */

  const rows = new Map(); // transfer id -> row elements

  function fileRow({ id, name, size, dir }) {
    const li = document.createElement('li');
    li.className = 'file-row';
    li.innerHTML = `
      <div class="file-head">
        <span class="file-dir mono">${dir === 'send' ? '\u2191' : '\u2193'}</span>
        <span class="file-name"></span>
        <span class="file-size mono">${formatBytes(size)}</span>
      </div>
      <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        <div class="bar-fill"></div>
      </div>
      <div class="file-actions"></div>
    `;
    li.querySelector('.file-name').textContent = name;
    fileList.appendChild(li);
    const row = {
      li,
      fill: li.querySelector('.bar-fill'),
      bar: li.querySelector('.bar'),
      actions: li.querySelector('.file-actions'),
    };
    rows.set(id, row);
    return row;
  }

  const transferHooks = {
    onIncoming(file) {
      activeCount++;
      setState('transferring');
      const row = fileRow({ ...file, dir: 'recv' });
      if (file.size > BIG_FILE_BYTES && 'showSaveFilePicker' in window) {
        statusEl.textContent = `Incoming: ${file.name} (${formatBytes(file.size)}) — choose where to save`;
        const btn = document.createElement('button');
        btn.className = 'btn btn-primary btn-small';
        btn.type = 'button';
        btn.textContent = 'Choose save location';
        btn.addEventListener('click', () => {
          btn.remove();
          transfer.acceptToDisk(file.id);
        });
        row.actions.appendChild(btn);
      }
    },

    onProgress(p) {
      const row = rows.get(p.id);
      if (!row) return;
      const pct = p.size ? Math.min(100, (p.sent / p.size) * 100) : 100;
      row.fill.style.width = `${pct}%`;
      row.bar.setAttribute('aria-valuenow', String(Math.round(pct)));
      liveStats.textContent = `${formatBytes(p.bps)}/s \u00b7 ${formatEta(p.eta)} left`;
      setState('transferring', `Transferring at ${formatBytes(p.bps)}/s`);
    },

    onComplete(f) {
      const row = rows.get(f.id);
      if (row) {
        row.fill.style.width = '100%';
        row.bar.setAttribute('aria-valuenow', '100');
        row.li.classList.add('is-done');
        if (f.dir === 'recv') {
          if (f.blobUrl) {
            const a = document.createElement('a');
            a.className = 'btn btn-primary btn-small';
            a.href = f.blobUrl;
            a.download = f.name;
            a.textContent = 'Save file';
            row.actions.appendChild(a);
          } else if (f.savedToDisk) {
            row.actions.textContent = 'Saved to disk \u2713';
          }
        }
      }
      activeCount = Math.max(0, activeCount - 1);
      if (activeCount === 0) {
        liveStats.textContent = '';
        setState('done');
      }
    },

    onError(message) {
      fail(message);
    },
  };

  function sendFiles(files) {
    if (!transfer || !files?.length) return;
    const items = transfer.enqueue(files);
    for (const { id, file } of items) {
      activeCount++;
      fileRow({ id, name: file.name, size: file.size, dir: 'send' });
    }
    setState('transferring');
  }

  fileInput.addEventListener('change', () => {
    sendFiles(fileInput.files);
    fileInput.value = '';
  });
  folderInput.addEventListener('change', () => {
    sendFiles(folderInput.files);
    folderInput.value = '';
  });

  ['dragover', 'dragenter'].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropZone.classList.add('is-drag');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropZone.classList.remove('is-drag');
    })
  );
  dropZone.addEventListener('drop', (e) => sendFiles(e.dataTransfer.files));

  window.addEventListener('beforeunload', () => session?.close());

  start();
}

// Custom Next.js server: serves the app over HTTPS and runs a blind WebSocket relay at /ws.
// Channels are identified by a hash of a secret code. The relay routes encrypted packets between
// devices and lists channels that were created as "visible". It never holds keys or plaintext.
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const next = require('next');
const { WebSocketServer } = require('ws');

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT) || 8443;
const MAX_MEMBERS = 16;

if (!fs.existsSync('key.pem') || !fs.existsSync('cert.pem')) {
  console.error('Missing key.pem / cert.pem. Run: npm run cert');
  process.exit(1);
}

const app = next({ dev });
const handle = app.getRequestHandler();
// id -> { name, listed, code, members: Map<cid, ws>, adminCid, adminFp, pendingRequests: Map<reqId, {name,fp,ts}>, approvedFps: Set, deniedRequests: Set }
const channels = new Map();

function parseJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 8192) reject(new Error('too large')); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('invalid json')); } });
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function notifyAdmin(ch) {
  if (!ch || !ch.adminCid) return;
  const ws = ch.members.get(ch.adminCid);
  if (ws && ws.readyState === 1) {
    const requests = [...ch.pendingRequests.entries()].map(([reqId, r]) => ({ reqId, name: r.name, fp: r.fp, ts: r.ts }));
    ws.send(JSON.stringify({ t: 'join_requests', requests }));
  }
}

app.prepare().then(() => {
  const srv = https.createServer(
    { key: fs.readFileSync('key.pem'), cert: fs.readFileSync('cert.pem') },
    async (req, res) => {
      const url = new URL(req.url, 'https://x');

      if (url.pathname === '/api/channels' && req.method === 'GET') {
        const list = [...channels]
          .filter(([, c]) => c.listed && c.members.size > 0)
          .map(([id, c]) => ({ id, name: c.name, count: c.members.size }));
        return sendJson(res, 200, list);
      }

      // Check if a display name is already taken among active connections
      if (url.pathname === '/api/check-name' && req.method === 'GET') {
        const qname = (url.searchParams.get('name') || '').trim().toLowerCase();
        // Gather all names in use across all channels
        const usedNames = new Set();
        for (const ch of channels.values()) {
          for (const devName of (ch.deviceNames?.values() || [])) {
            usedNames.add(devName.toLowerCase());
          }
        }
        return sendJson(res, 200, { taken: usedNames.has(qname) });
      }


      // Submit a join request for a public channel
      if (url.pathname === '/api/join-request' && req.method === 'POST') {
        let body;
        try { body = await parseJson(req); } catch { return sendJson(res, 400, { error: 'bad request' }); }
        const { channelId, name, fp } = body;
        const ch = channels.get(channelId);
        if (!ch || !ch.listed) return sendJson(res, 404, { error: 'channel not found or not public' });

        // Check if already approved
        if (ch.approvedFps.has(fp)) {
          return sendJson(res, 200, { status: 'approved', code: ch.code });
        }

        // Check if there's already a pending request from this fp
        const existingReq = [...ch.pendingRequests.entries()].find(([, r]) => r.fp === fp);
        if (existingReq) {
          return sendJson(res, 200, { status: 'pending', reqId: existingReq[0] });
        }

        const reqId = crypto.randomBytes(8).toString('hex');
        ch.pendingRequests.set(reqId, { name: (name || 'Unknown').slice(0, 40), fp: fp || '', ts: Date.now() });
        notifyAdmin(ch);
        return sendJson(res, 200, { status: 'pending', reqId });
      }

      // Poll join request status
      if (url.pathname === '/api/join-request/status' && req.method === 'GET') {
        const channelId = url.searchParams.get('channelId');
        const reqId = url.searchParams.get('reqId');
        const fp = url.searchParams.get('fp');
        const ch = channels.get(channelId);
        if (!ch) return sendJson(res, 200, { status: 'not_found' });
        if (fp && ch.approvedFps.has(fp)) return sendJson(res, 200, { status: 'approved', code: ch.code });
        if (reqId && ch.deniedRequests.has(reqId)) return sendJson(res, 200, { status: 'denied' });
        if (reqId && ch.pendingRequests.has(reqId)) return sendJson(res, 200, { status: 'pending' });
        return sendJson(res, 200, { status: 'not_found' });
      }

      // Admin responds to a join request
      if (url.pathname === '/api/join-request/respond' && req.method === 'POST') {
        let body;
        try { body = await parseJson(req); } catch { return sendJson(res, 400, { error: 'bad request' }); }
        const { channelId, adminFp, reqId, action } = body; // action: 'approve' | 'deny'
        const ch = channels.get(channelId);
        if (!ch) return sendJson(res, 404, { error: 'not found' });
        if (ch.adminFp !== adminFp) return sendJson(res, 403, { error: 'not admin' });
        const pending = ch.pendingRequests.get(reqId);
        if (!pending) return sendJson(res, 404, { error: 'request not found' });

        ch.pendingRequests.delete(reqId);
        if (action === 'approve') {
          ch.approvedFps.add(pending.fp);
          notifyAdmin(ch);
          return sendJson(res, 200, { ok: true, code: ch.code });
        } else {
          ch.deniedRequests.add(reqId);
          notifyAdmin(ch);
          return sendJson(res, 200, { ok: true });
        }
      }

      handle(req, res);
    }
  );

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  wss.on('connection', (ws, req) => {
    const q = new URL(req.url, 'https://x').searchParams;
    const id = q.get('ch') || '';
    if (!/^[a-f0-9]{32}$/.test(id)) return ws.close(1008, 'invalid channel');

    const isAdmin = q.get('admin') === '1';
    const deviceFp = q.get('fp') || '';
    const code = q.get('code') || '';

    const deviceName = (q.get('devname') || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 40);

    let ch = channels.get(id);
    if (!ch) {
      const name = (q.get('name') || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 40);
      const listed = q.get('listed') === '1' && name.length > 0;
      ch = {
        name,
        listed,
        code,
        members: new Map(),
        deviceNames: new Map(), // cid -> deviceName
        adminCid: null,
        adminFp: null,
        pendingRequests: new Map(),
        approvedFps: new Set(),
        deniedRequests: new Set(),
      };
      channels.set(id, ch);
    }
    if (ch.members.size >= MAX_MEMBERS) return ws.close(1008, 'channel is full');

    // For public channels, non-admin joiners must be approved OR be the channel creator (isAdmin)
    if (ch.listed && !isAdmin && deviceFp && !ch.approvedFps.has(deviceFp)) {
      return ws.close(1008, 'not approved');
    }

    const cid = crypto.randomBytes(4).toString('hex');
    ws.send(JSON.stringify({ t: 'welcome', cid, members: [...ch.members.keys()] }));
    for (const p of ch.members.values()) p.send(JSON.stringify({ t: 'joined', cid }));
    ch.members.set(cid, ws);
    if (deviceName) ch.deviceNames.set(cid, deviceName);

    // First device to join (or explicit admin flag) becomes admin
    if (!ch.adminCid || isAdmin) {
      if (!ch.adminCid) {
        ch.adminCid = cid;
        ch.adminFp = deviceFp;
      }
      ws.send(JSON.stringify({ t: 'role', role: 'admin' }));
      notifyAdmin(ch);
    } else {
      ws.send(JSON.stringify({ t: 'role', role: 'member' }));
    }

    ws.on('message', d => {
      let m;
      try { m = JSON.parse(d.toString()); } catch { return; }
      if ((m.t !== 'hello' && m.t !== 'msg') || typeof m.to !== 'string') return;
      const target = ch.members.get(m.to);
      if (target && target.readyState === 1) { m.from = cid; target.send(JSON.stringify(m)); }
    });

    ws.on('close', () => {
      ch.members.delete(cid);
      ch.deviceNames.delete(cid);
      for (const p of ch.members.values()) p.send(JSON.stringify({ t: 'left', cid }));
      // Promote a new admin if this was the admin
      if (ch.adminCid === cid) {
        if (ch.members.size > 0) {
          const [newAdminCid, newAdminWs] = [...ch.members.entries()][0];
          ch.adminCid = newAdminCid;
          newAdminWs.send(JSON.stringify({ t: 'role', role: 'admin' }));
          notifyAdmin(ch);
        } else {
          ch.adminCid = null;
          ch.adminFp = null;
        }
      }
      if (!ch.members.size) channels.delete(id);
    });
  });

  const upgradeNext = app.getUpgradeHandler();
  srv.on('upgrade', (req, socket, head) => {
    if (req.url && req.url.startsWith('/ws')) {
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    } else {
      upgradeNext(req, socket, head);
    }
  });

  srv.listen(port, '0.0.0.0', () => {
    console.log(`LAN Chat (${dev ? 'dev' : 'production'}). Open on any device on this Wi-Fi:`);
    for (const list of Object.values(os.networkInterfaces()))
      for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log(`  https://${i.address}:${port}`);
  });
});

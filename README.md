# LAN Chat (Next.js)

> **End-to-end encrypted, serverless-free chat between devices on the same Wi-Fi.**  
> No cloud. No accounts. No internet required after `npm install`.

Anyone can clone this repo, run three commands, and have a private encrypted chat room ready for every device on their local network in under a minute.

---

## ✨ Features

- 🔒 **End-to-end encrypted** — messages are encrypted on-device; the relay never sees plaintext
- 📡 **LAN-only** — works on any Wi-Fi, even with no internet (home router, mobile hotspot, office LAN)
- 👑 **Admin approval for public channels** — creator approves or denies join requests; no code sharing needed for public channels
- 🔑 **Private channels** — share a 16-character code directly; no one else can join without it
- 💬 **Direct messages** — encrypted 1-to-1 messages inside a channel
- 🏷️ **Unique device names** — enforced across all connected devices
- 📱 **Responsive** — works on phones, tablets and desktops
- 💾 **Local storage only** — messages saved in each browser's IndexedDB; deleting removes only your copy

---

## 🚀 Quick Start

### Prerequisites
- [Node.js](https://nodejs.org) v18 or later
- npm (comes with Node.js)

### Steps

```bash
# 1. Clone the repo
git clone https://github.com/kartheek6092/lan-chat.git
cd lan-chat-next

# 2. Install dependencies
npm install

# 3. Generate a self-signed SSL certificate for your LAN
#    (required for WebSockets over HTTPS — re-run if your IP changes)
npm run cert

# 4. Build the production bundle
npm run build

# 5. Start the server
npm start
```

The terminal will print something like:

```
LAN Chat (production). Open on any device on this Wi-Fi:
  https://192.168.1.34:8443
```

Open that URL on **every device** connected to the same Wi-Fi. Each browser will show a certificate warning — click **Advanced → Proceed** once to accept the self-signed cert.

> 💡 For development with hot-reload, use `npm run dev` instead of steps 4–5.

---

## 📖 How to use

### Creating a channel
1. Click **New channel** in the sidebar
2. Give it a name
3. Check **"Show in Nearby"** to make it discoverable to others on the same Wi-Fi — you'll approve each join request
4. Leave it unchecked for a **private channel** — share the generated code directly with people you want to invite
5. Click **Create and join**

### Joining a public (Nearby) channel
1. Public channels appear automatically in the **Nearby** section of the sidebar
2. Tap the channel → a join request is sent to the admin
3. Wait for the admin to approve — you'll see a spinner while waiting
4. Once approved, you're automatically connected — no code needed

### Joining a private channel
1. Click **Join with code** in the sidebar
2. Enter the 16-character code (format: `a1b2-c3d4-e5f6-0718`)
3. Click **Join**

### Admin approval panel
- When you're the channel creator (admin), a 🔔 badge appears in the thread header when someone requests to join
- Open the **Join Requests** panel and click **✓ Approve** or **✗ Deny** for each request
- If you disconnect, the next connected device automatically becomes the admin

### Direct messages
- Open a channel → click **Details** → click **Message** next to any device
- The DM is encrypted only for that specific device

### Verifying a device
- In **Details**, compare the **session code** aloud with the other person
- Click **Mark verified** to remember that device as trusted

---

## 🗂️ Project Structure

```
server.js                       Custom HTTPS server: Next.js + WebSocket relay + API routes
src/
  lib/
    chatCrypto.ts               Identity keys, signed handshakes, channel code → key derivation
    chatClient.ts               Per-peer encrypted sessions, channel fan-out, DMs (no React)
    db.ts                       Local IndexedDB: messages, conversations, channels, contacts
    encoding.ts                 Base64 / hex helpers
  components/
    ChatApp.tsx                 Main state: channels, peers, admin role, join requests
    Sidebar.tsx                 Channel list, Nearby discovery, join/create flows
    Thread.tsx                  Chat view, admin approval panel, device details
  app/
    globals.css                 All styles
    layout.tsx / page.tsx       Next.js entry point
```

---

## 🔌 API Reference (server.js)

| Endpoint | Method | Description |
|---|---|---|
| `/api/channels` | GET | List all public channels with active members |
| `/api/check-name` | GET | Check if a device name is already taken |
| `/api/join-request` | POST | Submit a join request for a public channel |
| `/api/join-request/status` | GET | Poll approval status of a join request |
| `/api/join-request/respond` | POST | Admin approves or denies a join request |
| `/ws` | WebSocket | Encrypted message relay between devices |

---

## 🔐 Security notes

- The **channel code** never leaves the device — the relay only sees a SHA-512 hash of it
- The code is mixed into key derivation, so the relay **cannot impersonate** a member without guessing the 64-bit code
- Devices without the code never become visible peers (key confirmation step)
- **Compare the session code aloud** to verify a device is who you think it is
- For public channels, the admin must **explicitly approve** each joiner — no code leaks
- ⚠️ Not security-audited. The identity key and local message history are stored **unencrypted** in the browser (a passphrase lock would be a good next step)
- The self-signed certificate protects the transport but will trigger browser warnings — this is expected

---

## ⚠️ Important: Not for internet hosting

This app is designed for **local networks only**. It will not work on Vercel or other serverless platforms because it requires:
- A persistent WebSocket server
- In-memory state (channel list, join request queue)

To run it for a group on the internet, use a VPS (Railway, Render, Fly.io, DigitalOcean, etc.) and run `npm start` there.

---

## 📋 Requirements summary

| Requirement | Detail |
|---|---|
| All devices on the **same Wi-Fi** | Router, mobile hotspot, or any LAN |
| One machine runs `npm start` | Acts as the relay server |
| Port **8443** open on host firewall | Required for other devices to connect |
| Browser with **WebSocket + IndexedDB** | All modern browsers qualify |
| Internet | ❌ Not needed after `npm install` |

---

## 📄 License

MIT

# Office

A virtual office for your team's local network. Everyone has a room on an interactive floor plan, so you can see who's around, ring a coworker's doorbell, and walk in to talk. It runs entirely on your office Wi-Fi: one computer is the server, and everyone else uses the desktop app.

> **Status: Phase 2 of 6.** Done so far: the office map, presence, statuses, doorbells, room locks, profiles, the admin area, and voice. Coming next: music, messaging, meeting rooms with screen sharing, and installers. See the [roadmap](#roadmap).

| Light | Dark |
| --- | --- |
| ![The office map in the light theme](docs/screenshots/office-light.png) | ![The office map in the dark theme](docs/screenshots/office-dark.png) |
| ![A room's side panel](docs/screenshots/panel-light.png) | ![A doorbell ringing](docs/screenshots/doorbell-dark.png) |
| ![Managing people](docs/screenshots/people-light.png) | ![The floor plan editor](docs/screenshots/editor-dark.png) |
| ![In a call, with the voice dock](docs/screenshots/voice-light.png) | ![Per-person volume in a call](docs/screenshots/voice-dark.png) |

## What it does today

- **Live office map.** A floor plan with personal rooms, meeting rooms and lounges. Avatars walk between rooms in real time, and people outside any room stand in the hallway.
- **Doors and doorbells.** Each room is *Open* (walk in), *Knock* (ring the bell, someone inside lets you in) or *Locked*. A doorbell plays a chime and shows a 30-second card with **Let them in** / **Not now**.
- **Voice.** Walk into a room and you're talking with everyone there. A dock at the bottom shows who's in the call, with mute, sound off and leave buttons. Speaking avatars glow on the map, and muted people show a crossed-out mic.
  - Each person in your room has a volume slider. Volumes are remembered on your computer.
  - Audio settings let you pick the microphone and speakers, check your level on a live meter, and switch noise suppression and echo cancellation.
  - Shortcuts: **Ctrl+Shift+M** mutes, **Ctrl+Shift+D** turns sound off (Cmd on a Mac). If you talk while muted, the app reminds you.
  - Your mic only switches on while someone else is in your room, so the system's "mic in use" light goes off when you're alone.
- **Statuses.** Available, Busy, Away or Do not disturb, plus a custom status line. Do not disturb locks your door and silences your doorbell.
- **Profiles.** Name, title, color, emoji or uploaded photo, and password.
- **Admin area.** Add and remove people (with generated passwords and an automatic personal room), and edit the floor plan by dragging, resizing, recoloring and assigning rooms.
- **Light and dark themes**, following the system or chosen by hand, with smooth animations throughout (they respect the OS "reduce motion" setting).

## Running it

You need [Node.js 22](https://nodejs.org) or newer on the server computer.

```bash
npm install
npm run build
npm start
```

The server prints its address, for example:

```
  Office server is running.

  On this computer:  http://localhost:4000
  On the office Wi-Fi: http://192.168.1.20:4000
```

Open that address. The first visit asks you to set up the office and create the admin account. Then go to **Admin → People** to add your coworkers.

| Setting | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4000` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to listen on (all, so the LAN can reach it) |
| `DATA_DIR` | `server/data` | Where the database, avatars and signing key live. Back this folder up. |

If coworkers can't connect, allow port 4000 through the server computer's firewall (on Windows, accept the prompt the first time Node starts).

### The desktop app

```bash
cd desktop
npm install        # downloads Electron
npm start
```

On first launch it asks for the server address (for example `192.168.1.20:4000`) and remembers it. Closing the window keeps the app in the system tray, so doorbells still ring. The tray menu can start it when you sign in to your computer. Windows and macOS installers come in Phase 6.

### Developing

```bash
npm run dev        # server on :4000 with reload, web app on :5173 with hot reload
npm test           # server tests
npm run typecheck
```

## How it's built

```
shared/   Types and the realtime protocol used by both sides
server/   Fastify + WebSockets + SQLite (Node's built-in node:sqlite)
web/      React + Vite + Framer Motion + Zustand: the whole UI
desktop/  Electron shell that loads the UI from the office server
```

- The server keeps users, rooms and the floor in SQLite, and keeps live state in memory: who's online, where everyone is, and doorbells in flight. Every change is pushed to every app over one WebSocket.
- The desktop app loads the UI from the server, so updating the server updates everyone.
- Voice is peer to peer over WebRTC. Everyone in a room has a direct audio link to each other person there, negotiated through the server, which only relays between people in the same room. On a LAN no STUN or TURN server is needed, and audio never passes through the server.
- Browsers only allow the microphone on secure pages. The desktop app allows it for your office server. In a plain browser, voice works at `http://localhost` (on the server computer itself) or behind HTTPS.
- Passwords are hashed with scrypt, and sessions are signed tokens.
- No internet access is needed at runtime. Fonts and sounds are bundled or synthesized.

## Roadmap

1. ✅ **Core:** sign-in, admin, floor plan editor, live map, presence, statuses, doorbells, locks
2. ✅ **Voice:** talk with everyone in your room, mute, sound off, per-person volume, device settings
3. **Music:** a shared library with uploads and a synced queue per room, plus streaming your computer's own audio
4. **Messaging:** direct messages, room chat, an office channel, unread badges and notifications
5. **Meeting rooms and screen sharing**
6. **Packaging:** Windows/macOS installers and a one-step server setup

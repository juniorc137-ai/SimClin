const express = require("express");
const { WebSocketServer } = require("ws");
const path = require("path");

const app = express();
app.use(express.static(path.join(__dirname, "public")));

// Rota catch-all → index.html (SPA)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`SimClin rodando na porta ${PORT}`));

// ── WebSocket Relay ──────────────────────────────────────────────────────────
// Rooms: Map<roomCode, { instructor: ws|null, monitors: Set<ws> }>
const rooms = new Map();

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  let wsRoom = null;
  let wsRole = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── JOIN ──
    if (msg.type === "join") {
      const { room, role } = msg;
      if (!room || !role) return;

      wsRoom = String(room).slice(0, 4);
      wsRole = role;

      if (!rooms.has(wsRoom)) {
        rooms.set(wsRoom, { instructor: null, monitors: new Set(), state: null });
      }
      const r = rooms.get(wsRoom);

      if (role === "instructor") {
        // Se havia instrutor anterior, fecha
        if (r.instructor && r.instructor !== ws && r.instructor.readyState === 1) {
          r.instructor.close();
        }
        r.instructor = ws;
        ws.send(JSON.stringify({ type: "joined", role: "instructor", room: wsRoom }));
        // Envia estado atual para o instrutor (se havia)
        if (r.state) ws.send(JSON.stringify({ type: "state", state: r.state }));
      } else {
        r.monitors.add(ws);
        ws.send(JSON.stringify({ type: "joined", role: "monitor", room: wsRoom }));
        // Envia estado atual para o monitor
        if (r.state) ws.send(JSON.stringify({ type: "state", state: r.state }));
      }
      return;
    }

    // ── STATE UPDATE (instrutor → monitores) ──
    if (msg.type === "state" && wsRole === "instructor" && wsRoom) {
      const r = rooms.get(wsRoom);
      if (!r) return;
      r.state = msg.state;
      // Broadcast para todos os monitores
      r.monitors.forEach((m) => {
        if (m.readyState === 1) {
          m.send(JSON.stringify({ type: "state", state: msg.state }));
        }
      });
      return;
    }
  });

  ws.on("close", () => {
    if (!wsRoom) return;
    const r = rooms.get(wsRoom);
    if (!r) return;
    if (wsRole === "instructor" && r.instructor === ws) {
      r.instructor = null;
    } else {
      r.monitors.delete(ws);
    }
    // Limpa sala vazia após 10 min
    if (!r.instructor && r.monitors.size === 0) {
      setTimeout(() => {
        const cur = rooms.get(wsRoom);
        if (cur && !cur.instructor && cur.monitors.size === 0) rooms.delete(wsRoom);
      }, 600000);
    }
  });

  ws.on("error", () => {});
});

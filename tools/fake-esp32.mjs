#!/usr/bin/env node
/**
 * Simulador do ESP32 + encoder KY-040 (sem hardware, sem dependências).
 * Implementa o MESMO protocolo do firmware (firmware/furadeira_esp32).
 *
 *   node tools/fake-esp32.mjs            → porta 81
 *   PORT=8181 node tools/fake-esp32.mjs  → outra porta
 *   node tools/fake-esp32.mjs --demo     → gira/liga/inverte sozinho
 *
 * Teclado (simula o encoder):
 *   → ou +   girar para a direita (+RPM)   (repetição rápida = passo maior)
 *   ← ou −   girar para a esquerda (−RPM)
 *   Espaço / Enter   clique curto  → liga/desliga
 *   L                clique longo  → inverte o sentido
 *   Ctrl+C           sair
 */
import crypto from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.PORT || 81);
const RPM_MAX = 3000;
const STEP_SLOW = 50;
const STEP_FAST = 200;
const FAST_MS = 45;

const st = { rpm: 1200, power: false, direction: 1 };
const clients = new Set();

// ------------------------------------------------------- WebSocket mínimo
const server = http.createServer((_, res) => {
  res.writeHead(426, { "Content-Type": "text/plain" });
  res.end("Somente WebSocket");
});

server.on("upgrade", (req, sock) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) return sock.destroy();
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  sock.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  clients.add(sock);
  log(`[ws] cliente conectado (${clients.size})`);
  sendTo(sock); // o "ESP32" é a referência ao conectar

  let buf = Buffer.alloc(0);
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const f = readFrame(buf);
      if (!f) break;
      buf = buf.subarray(f.size);
      if (f.op === 0x8) return sock.end(frame(Buffer.alloc(0), 0x8));
      if (f.op === 0x9) sock.write(frame(f.data, 0xa));
      if (f.op === 0x1) onText(sock, f.data.toString("utf8"));
    }
  });
  const drop = () => {
    if (clients.delete(sock)) log(`[ws] cliente desconectado (${clients.size})`);
  };
  sock.on("close", drop);
  sock.on("error", drop);
});

function readFrame(b) {
  if (b.length < 2) return null;
  const op = b[0] & 0x0f;
  const masked = (b[1] & 0x80) !== 0;
  let len = b[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (b.length < 4) return null;
    len = b.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (b.length < 10) return null;
    len = Number(b.readBigUInt64BE(2));
    off = 10;
  }
  const mlen = masked ? 4 : 0;
  if (b.length < off + mlen + len) return null;
  let data = b.subarray(off + mlen, off + mlen + len);
  if (masked) {
    const m = b.subarray(off, off + 4);
    data = Buffer.from(data.map((x, i) => x ^ m[i % 4]));
  }
  return { op, data, size: off + mlen + len };
}

function frame(payload, op = 0x1) {
  const p = Buffer.from(payload);
  let h;
  if (p.length < 126) h = Buffer.from([0x80 | op, p.length]);
  else {
    h = Buffer.alloc(4);
    h[0] = 0x80 | op;
    h[1] = 126;
    h.writeUInt16BE(p.length, 2);
  }
  return Buffer.concat([h, p]);
}

// ------------------------------------------------------------ Protocolo
const json = () => JSON.stringify({ rpm: st.rpm, power: st.power, direction: st.direction });
const sendTo = (sock) => sock.writable && sock.write(frame(json()));
const broadcast = (except) => clients.forEach((c) => c !== except && sendTo(c));

function onText(sock, text) {
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    return;
  }
  if (d.type === "hello") return sendTo(sock);
  const n = { ...st };
  if (typeof d.rpm === "number") n.rpm = Math.max(0, Math.min(RPM_MAX, Math.round(d.rpm)));
  if (typeof d.power === "boolean") n.power = d.power;
  if (d.direction === 1 || d.direction === -1) n.direction = d.direction;
  if (n.rpm !== st.rpm || n.power !== st.power || n.direction !== st.direction) {
    Object.assign(st, n);
    log(`[página] ${describe()}`);
    broadcast(sock); // sincroniza os outros clientes
  }
}

// ------------------------------------------------- "Encoder" e "botão"
let lastTurn = 0;
function turn(detents) {
  const now = Date.now();
  const step = now - lastTurn < FAST_MS ? STEP_FAST : STEP_SLOW;
  lastTurn = now;
  st.rpm = Math.max(0, Math.min(RPM_MAX, st.rpm + detents * step));
  changed("RPM");
}
function shortPress() {
  st.power = !st.power;
  changed(st.power ? "LIGAR" : "DESLIGAR");
}
function longPress() {
  st.direction = -st.direction;
  changed("INVERTER");
}
function changed(why) {
  log(`[encoder] ${why.padEnd(9)} ${describe()}`);
  broadcast();
}

const describe = () =>
  `rpm=${String(st.rpm).padStart(4)}  ${st.power ? "LIGADA   " : "DESLIGADA"}  ${st.direction > 0 ? "horário" : "anti-horário"}`;
const log = (s) => console.log(s);

// ------------------------------------------------------------- Entrada
if (process.argv.includes("--demo") || !process.stdin.isTTY) {
  const seq = [
    () => turn(+2), () => shortPress(), () => turn(+4), () => turn(+4), () => longPress(),
    () => turn(-6), () => shortPress(),
  ];
  let i = 0;
  setInterval(() => seq[i++ % seq.length](), 1500);
  log("Modo demonstração: muda o estado a cada 1,5 s.");
} else {
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (k) => {
    if (k === "\u0003") process.exit(0);
    else if (k === "\u001b[C" || k === "+" || k === "=") turn(+1);
    else if (k === "\u001b[D" || k === "-") turn(-1);
    else if (k === " " || k === "\r") shortPress();
    else if (k === "l" || k === "L") longPress();
  });
  log("Teclado: →/+ e ←/− giram, Espaço = clique curto, L = clique longo, Ctrl+C sai.");
}

server.listen(PORT, () => log(`ESP32 simulado em ws://localhost:${PORT}  — ${describe()}`));

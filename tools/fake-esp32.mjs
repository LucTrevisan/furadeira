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
 *   V                vibração (MPU6050): normal → atenção → alta
 *   P                mão aproxima/afasta (HC-SR04 → vista explodida)
 *   --mqtt           também publica no broker MQTT (TOPIC=… BROKER=…), como o firmware
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
  hello(sock); // a aplicação responde com o estado (fonte da verdade)

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

// ------------------------------------------------------------ Protocolo v2
// Mesmo protocolo do firmware 2.0: a APLICAÇÃO é a fonte do estado.
const sim = { vibLevel: 0, vibPct: 0, distance: null, hand: false, handT: 0, lastEncoder: 0 };
// ---- MQTT (opcional): node tools/fake-esp32.mjs --mqtt [--demo]
//      TOPIC=senai-furadeira/xxxx  BROKER=wss://public.cloud.shiftr.io:443  (usuário/senha "public")
const MQTT_MODE = process.argv.includes("--mqtt");
const TOPIC = (process.env.TOPIC || "senai-furadeira/d3f5f010").replace(/\/+$/, "");
let mq = null;
const mqPublish = (obj) => mq?.connected && mq.publish(`${TOPIC}/up`, JSON.stringify(obj));
// sock = null → mensagem para a aplicação via MQTT
const send = (sock, obj) => (sock ? sock.writable && sock.write(frame(JSON.stringify(obj))) : mqPublish(obj));
const broadcastObj = (obj) => {
  clients.forEach((c) => send(c, obj));
  mqPublish(obj);
};
const SENSORS = { encoder: true, mpu6050: true, hcsr04: true, lcd: true };
const hello = (sock) => send(sock, { type: "hello", device: "ESP32 simulado", fw: "2.0-sim", sensors: SENSORS });

function onText(sock, text) {
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    return;
  }
  if (d.type === "hello") return hello(sock ?? null);
  if (d.type !== "status" && d.type !== "state") return;
  const n = { ...st };
  if (typeof d.rpm === "number" && Date.now() - sim.lastEncoder > 500) n.rpm = Math.max(0, Math.min(RPM_MAX, Math.round(d.rpm)));
  if (typeof d.power === "boolean") n.power = d.power;
  if (d.direction === 1 || d.direction === -1) n.direction = d.direction;
  if (n.rpm !== st.rpm || n.power !== st.power || n.direction !== st.direction) {
    Object.assign(st, n);
    log(`[LCD]     estado da app: ${describe()}${d.exploded ? "  (explodida)" : ""}`);
  }
}

// ------------------------------------------------- "Encoder" e "botão"
let lastTurn = 0;
function turn(detents) {
  const now = Date.now();
  const step = now - lastTurn < FAST_MS ? STEP_FAST : STEP_SLOW;
  lastTurn = sim.lastEncoder = now;
  st.rpm = Math.max(0, Math.min(RPM_MAX, st.rpm + detents * step));
  log(`[KY040]   RPM: ${st.rpm}`);
  broadcastObj({ type: "event", event: "encoder", rpm: st.rpm });
}
function shortPress() {
  log(`[KY040]   botão → ${st.power ? "desligar" : "ligar"}`);
  broadcastObj({ type: "event", event: "power", power: !st.power });
}
function longPress() {
  log("[KY040]   clique longo → inverter");
  broadcastObj({ type: "event", event: "direction", direction: -st.direction });
}

// ------------------------------------------- "MPU6050" e "HC-SR04"
function cycleVibration() {
  sim.vibLevel = (sim.vibLevel + 1) % 3;
  log(`[MPU6050] vibração simulada: ${["NORMAL", "ATENÇÃO", "ALTA"][sim.vibLevel]}`);
}
function toggleHand() {
  sim.hand = !sim.hand;
  log(`[HC-SR04] mão ${sim.hand ? "aproximando" : "afastando"}`);
}
let exploded = false;
let near = 0;
let far = 0;
let lastSent = "";
setInterval(() => {
  // Vibração: alvo por nível + ruído, suavizada.
  const target = [5, 48, 86][sim.vibLevel] + (Math.random() - 0.5) * 6;
  sim.vibPct += (Math.max(0, target) - sim.vibPct) * 0.25;
  // Mão: aproxima de 20 cm até 2 cm em ~2 s (e volta).
  sim.handT = Math.max(0, Math.min(1, sim.handT + (sim.hand ? 0.025 : -0.025)));
  sim.distance = sim.handT > 0 ? +(20 - 18 * sim.handT).toFixed(1) : null;
  // Mesma regra do firmware: < 3 cm (30 mm, 3 leituras) explode; ≥ 5 cm monta.
  near = sim.distance !== null && sim.distance < 3 ? near + 1 : 0;
  far = sim.distance === null || sim.distance >= 5 ? far + 1 : 0;
  if (!exploded && near >= 3) {
    exploded = true;
    log("[HC-SR04] < 30 mm → explode");
    broadcastObj({ type: "event", event: "explode" });
  } else if (exploded && far >= 3) {
    exploded = false;
    log("[HC-SR04] ≥ 5 cm → monta");
    broadcastObj({ type: "event", event: "assemble" });
  }
  const pct = +sim.vibPct.toFixed(1);
  const level = pct > 70 ? "high" : pct > 30 ? "attention" : "normal";
  const g = (pct / 100) * 0.35;
  const msg = {
    type: "telemetry",
    rpm: st.rpm,
    distance: sim.distance,
    vibration: { x: +(g * 0.6).toFixed(3), y: +(g * 0.3).toFixed(3), z: +(g * 0.74).toFixed(3), magnitude: +g.toFixed(3), percent: pct, level },
    sensors: SENSORS,
  };
  const key = `${Math.round(pct)}|${sim.distance}|${level}`;
  if (key !== lastSent || Date.now() % 1000 < 50) {
    lastSent = key;
    broadcastObj(msg);
  }
}, 50);

const describe = () =>
  `rpm=${String(st.rpm).padStart(4)}  ${st.power ? "LIGADA   " : "DESLIGADA"}  ${st.direction > 0 ? "horário" : "anti-horário"}`;
const log = (s) => console.log(s);

// ------------------------------------------------------------- Entrada
if (process.argv.includes("--demo") || !process.stdin.isTTY) {
  const seq = [
    () => turn(+2), () => shortPress(), () => turn(+4), () => cycleVibration(), () => toggleHand(),
    () => cycleVibration(), () => toggleHand(), () => cycleVibration(), () => longPress(), () => turn(-6), () => shortPress(),
  ];
  let i = 0;
  setInterval(() => seq[i++ % seq.length](), 2500);
  log("Modo demonstração: muda algo a cada 2,5 s.");
} else {
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (k) => {
    if (k === "\u0003") process.exit(0);
    else if (k === "\u001b[C" || k === "+" || k === "=") turn(+1);
    else if (k === "\u001b[D" || k === "-") turn(-1);
    else if (k === " " || k === "\r") shortPress();
    else if (k === "l" || k === "L") longPress();
    else if (k === "v" || k === "V") cycleVibration();
    else if (k === "p" || k === "P") toggleHand();
  });
  log("Teclado: →/+ ←/− encoder · Espaço clique · L clique longo · V vibração · P mão (HC-SR04) · Ctrl+C sai.");
}

server.listen(PORT, () => log(`ESP32 simulado (protocolo 2.0) em ws://localhost:${PORT}`));

if (MQTT_MODE) {
  const { connect } = await import("mqtt");
  const broker = process.env.BROKER || "wss://public.cloud.shiftr.io:443";
  mq = connect(broker, {
    username: process.env.MQTT_USER ?? "public",
    password: process.env.MQTT_PASS ?? "public",
    clientId: `furadeira-sim-${crypto.randomBytes(3).toString("hex")}`,
    will: { topic: `${TOPIC}/online`, payload: "0", retain: true, qos: 1 }, // igual ao firmware
  });
  mq.on("connect", () => {
    mq.publish(`${TOPIC}/online`, "1", { retain: true, qos: 1 });
    mq.subscribe(`${TOPIC}/down`);
    log(`[MQTT] conectado a ${broker} · tópico ${TOPIC}`);
    hello(null);
  });
  mq.on("message", (_t, payload) => onText(null, payload.toString()));
  mq.on("error", (e) => log(`[MQTT] erro: ${e.message}`));
  const bye = () => mq.publish(`${TOPIC}/online`, "0", { retain: true }, () => process.exit(0));
  process.on("SIGINT", bye);
}

import { IOT, MQTT, WEBSOCKET } from "./config";
import type { DrillController, RemoteCommand } from "./drillController";
import { describeTarget, type LinkTarget, openMqtt, openWebSocket, type Transport, type TransportEvents } from "./iotTransport";
import type { WsStatus } from "./ui";

/**
 * Ligação com o ESP32 — ÚNICO módulo de comunicação da camada IoT, por
 * WebSocket local ou por MQTT (ver iotTransport.ts; mensagens idênticas).
 * Não contém lógica de cena: valida as mensagens e as encaminha para as
 * funções que já existem (DrillController.applyRemote, vista explodida…).
 *
 * RECEBIDAS do ESP32 (firmware v2):
 *   {"type":"hello","device":"…","sensors":{"encoder":true,…}}
 *   {"type":"event","event":"encoder","rpm":1350}          → RPM (mesmo setpoint do slider)
 *   {"type":"event","event":"power","power":true}          → liga/desliga
 *   {"type":"event","event":"direction","direction":-1}    → sentido
 *   {"type":"event","event":"explode"} / "assemble"        → vista explodida existente
 *   {"type":"telemetry","rpm":…,"distance":8.4|null,
 *    "vibration":{"x","y","z","magnitude","percent","level"},"sensors":{…}}
 * Formato anterior (firmware v1, simulador antigo) continua aceito:
 *   {"rpm":1500,"power":true,"direction":1}
 *
 * ENVIADAS à placa (a aplicação é a fonte do estado; o LCD mostra o estado real):
 *   {"type":"hello"} ao conectar
 *   {"type":"status","machine":"running"|"stopped","rpm":1500,"power":true,
 *    "direction":1,"exploded":false}   a cada mudança (confirmação)
 */
export interface IoTSensors {
  encoder: boolean;
  mpu6050: boolean;
  hcsr04: boolean;
  lcd: boolean;
}

export interface IoTTelemetry {
  /** 0–100 % (já filtrado no ESP32). */
  vibrationPercent: number;
  vibrationLevel: "normal" | "attention" | "high";
  vibrationAxes: { x: number; y: number; z: number; magnitude: number };
  /** cm, ou null sem objeto à frente / sensor ausente. */
  distance: number | null;
  sensors: IoTSensors | null;
}

export interface IoTHandlers {
  onStatus: (s: WsStatus, detail?: string) => void;
  /** HC-SR04: true = explodir, false = recompor (usa a vista explodida existente). */
  onExplode: (exploded: boolean) => void;
  /** Telemetria nova; null ao desconectar (volta ao MODO NORMAL). */
  onTelemetry: (t: IoTTelemetry | null) => void;
  onHello: (info: { device: string; sensors: IoTSensors | null }) => void;
}

type Parsed =
  | { kind: "command"; cmd: RemoteCommand; legacy: boolean }
  | { kind: "explode"; exploded: boolean }
  | { kind: "telemetry"; t: IoTTelemetry }
  | { kind: "hello"; device: string; sensors: IoTSensors | null };

const log = (...a: unknown[]): void => {
  if (IOT.debug) console.log(...a);
};

export class Esp32Link {
  private transport: Transport | null = null;
  private target: LinkTarget | null = null;
  private wantConnected = false;
  private peerOnline = false;
  private attempt = 0;
  private retryTimer: number | undefined;
  private heartbeat: number | undefined;
  /** Verdadeiro ao aplicar comando no formato ANTIGO: o firmware v1 adotava ecos. */
  private applyingLegacy = false;
  private exploded = false;

  private readonly handlers: IoTHandlers;

  constructor(
    private readonly drill: DrillController,
    handlers: IoTHandlers,
  ) {
    // Falha na camada IoT NUNCA pode derrubar a aplicação: cada handler é isolado.
    const safe = <A extends unknown[]>(name: string, fn: (...a: A) => void) => (...a: A): void => {
      try {
        fn(...a);
      } catch (e) {
        console.error(`[ESP32] erro em ${name} (aplicação segue normalmente):`, e);
      }
    };
    this.handlers = {
      onStatus: safe("onStatus", handlers.onStatus),
      onExplode: safe("onExplode", handlers.onExplode),
      onTelemetry: safe("onTelemetry", handlers.onTelemetry),
      onHello: safe("onHello", handlers.onHello),
    };
    // Toda mudança de estado é confirmada ao ESP32 (LCD mostra o estado real).
    drill.onChange(() => {
      if (!this.applyingLegacy) this.sendStatus();
    });
  }

  get isActive(): boolean {
    return this.wantConnected;
  }

  /** ESP32 presente (WebSocket aberto, ou placa "online" no broker MQTT). */
  get isConnected(): boolean {
    return this.peerOnline;
  }

  connect(target: LinkTarget): void {
    this.disconnect();
    if (target.kind === "websocket") {
      if (!/^wss?:\/\//i.test(target.url)) {
        this.handlers.onStatus("error", "A URL deve começar com ws:// ou wss://");
        return;
      }
      if (location.protocol === "https:" && target.url.toLowerCase().startsWith("ws://")) {
        // Navegadores bloqueiam ws:// em páginas HTTPS (conteúdo misto).
        console.warn("[ESP32] Página HTTPS + ws:// será bloqueada pelo navegador. Use wss://, a ponte /esp32 ou MQTT.");
      }
    } else {
      if (!/^wss?:\/\//i.test(target.url)) {
        this.handlers.onStatus("error", "O broker deve ser wss://… (MQTT sobre WebSocket)");
        return;
      }
      if (!/^[\w\-./]+$/.test(target.topic) || target.topic.includes("#") || target.topic.includes("+")) {
        this.handlers.onStatus("error", "Tópico inválido (use letras, números, - _ /)");
        return;
      }
    }
    this.target = target;
    this.wantConnected = true;
    this.attempt = 0;
    this.open();
  }

  disconnect(): void {
    this.wantConnected = false;
    window.clearTimeout(this.retryTimer);
    this.stopHeartbeat();
    this.transport?.close();
    this.transport = null;
    this.setPeer(false, false);
    this.handlers.onStatus("disconnected");
  }

  /** Estado da vista explodida (para o LCD): enviado só quando muda. */
  setExploded(exploded: boolean): void {
    if (exploded === this.exploded) return;
    this.exploded = exploded;
    this.sendStatus();
  }

  /** Processa uma mensagem como se viesse do ESP32 (testes: drill.simulateMessage). */
  handleMessage(raw: string): boolean {
    try {
      return this.dispatch(raw);
    } catch (e) {
      console.error("[ESP32] erro ao processar mensagem (ignorada):", e);
      return false;
    }
  }

  private dispatch(raw: string): boolean {
    const m = parseMessage(raw);
    if (!m) {
      log("[ESP32] mensagem ignorada (inválida):", raw);
      return false;
    }
    switch (m.kind) {
      case "command":
        log(m.cmd.rpm !== undefined ? `[KY040] RPM: ${m.cmd.rpm}` : "[ESP32] comando", m.cmd);
        this.applyingLegacy = m.legacy;
        try {
          this.drill.applyRemote(m.cmd); // MESMA função usada pelo slider/painel
        } finally {
          this.applyingLegacy = false;
        }
        break;
      case "explode":
        log(`[HC-SR04] ${m.exploded ? "explode" : "monta"}`);
        this.handlers.onExplode(m.exploded);
        break;
      case "telemetry":
        log(`[MPU6050] vibração: ${m.t.vibrationPercent.toFixed(0)}% · [HC-SR04] distância: ${m.t.distance ?? "--"} cm`);
        this.handlers.onTelemetry(m.t);
        break;
      case "hello":
        log("[ESP32] conectado:", m.device, m.sensors);
        this.setPeer(true); // no MQTT, um "hello" também prova que a placa está ativa
        this.handlers.onHello({ device: m.device, sensors: m.sensors });
        this.sendStatus(); // sincroniza a placa com o estado atual
        break;
    }
    return true;
  }

  private sendStatus(): void {
    const s = this.drill.state;
    this.send({
      type: "status",
      machine: s.power ? "running" : "stopped",
      rpm: s.setpointRPM,
      power: s.power, // compatível com o firmware v1
      direction: s.direction,
      exploded: this.exploded,
    });
  }

  /** Placa presente/ausente → status "connected" ou "aguardando ESP32". */
  private setPeer(online: boolean, notify = true): void {
    if (online === this.peerOnline) return;
    this.peerOnline = online;
    if (!online) this.handlers.onTelemetry(null); // MODO NORMAL: sem vibração física
    if (!notify || !this.target) return;
    if (online) {
      this.attempt = 0;
      log("[ESP32] online");
      this.handlers.onStatus("connected", describeTarget(this.target));
    } else {
      log("[ESP32] offline");
      this.handlers.onStatus("connecting", "Broker conectado · aguardando o ESP32");
    }
  }

  private open(): void {
    const target = this.target;
    if (!target) return;
    this.handlers.onStatus("connecting", describeTarget(target));
    const events: TransportEvents = {
      open: () => {
        log(`[ESP32] via ${target.kind} pronta`);
        if (target.kind === "mqtt") {
          this.handlers.onStatus("connecting", "Broker conectado · aguardando o ESP32");
          this.startHeartbeat();
        }
        this.send({ type: "hello" });
        this.sendStatus();
      },
      peer: (online) => this.setPeer(online),
      message: (text) => this.handleMessage(text),
      close: (reason) => {
        this.transport = null;
        this.stopHeartbeat();
        this.setPeer(false, false);
        log("[ESP32] desconectado:", reason);
        if (this.wantConnected) {
          this.handlers.onStatus("error", reason);
          this.scheduleReconnect();
        } else this.handlers.onStatus("disconnected");
      },
    };
    try {
      this.transport = target.kind === "websocket" ? openWebSocket(target.url, events) : openMqtt(target, events);
    } catch (e) {
      this.handlers.onStatus("error", String(e));
      this.scheduleReconnect();
    }
  }

  /** MQTT: a placa considera a aplicação ativa enquanto receber mensagens. */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = window.setInterval(() => this.sendStatus(), MQTT.heartbeatMs);
  }

  private stopHeartbeat(): void {
    window.clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private scheduleReconnect(): void {
    if (!this.wantConnected) return;
    window.clearTimeout(this.retryTimer);
    const delays = WEBSOCKET.reconnectDelaysMs;
    const ms = delays[Math.min(this.attempt, delays.length - 1)];
    this.attempt++;
    this.retryTimer = window.setTimeout(() => this.open(), ms);
  }

  private send(obj: object): void {
    this.transport?.send(JSON.stringify(obj));
  }
}

/** Conectar automaticamente? (ver WEBSOCKET.autoConnect) */
export function shouldAutoConnect(): boolean {
  const a = WEBSOCKET.autoConnect;
  if (a !== "local") return a;
  const h = location.hostname;
  return (
    h === "localhost" ||
    h.endsWith(".local") ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

/**
 * Resolve "auto" para a ponte do servidor Vite (mesma origem da página):
 * https://pc:5173 → wss://pc:5173/esp32 ; http://localhost:5173 → ws://localhost:5173/esp32
 */
export function resolveWsUrl(url: string): string {
  if (url !== "auto") return url;
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/esp32`;
}

/** Configuração da ligação com o ESP32 (editável em "IoT / Hardware"). */
export interface LinkSettings {
  transport: "mqtt" | "websocket";
  wsUrl: string;
  mqttUrl: string;
  mqttTopic: string;
  mqttUser: string;
  mqttPass: string;
}

export function toTarget(s: LinkSettings): LinkTarget {
  return s.transport === "mqtt"
    ? { kind: "mqtt", url: s.mqttUrl.trim(), topic: s.mqttTopic.trim(), username: s.mqttUser.trim(), password: s.mqttPass }
    : { kind: "websocket", url: resolveWsUrl(s.wsUrl.trim()) };
}

const PREF_KEY = "furadeira.iot";
const OLD_PREF_KEY = "furadeira.websocket";
const PASS_KEY = "furadeira.iot.pass";

/**
 * Configuração salva neste navegador (padrões em config.ts). A senha do
 * broker fica só na sessão (sessionStorage), nunca gravada de forma permanente.
 * Parâmetros de URL têm prioridade: ?ws=ws://… força WebSocket;
 * ?mqtt=<tópico> força MQTT com esse tópico.
 */
export function loadLinkPrefs(): { settings: LinkSettings; connect?: boolean } {
  const read = (k: string): Record<string, unknown> => {
    try {
      return JSON.parse(localStorage.getItem(k) ?? "{}");
    } catch {
      return {};
    }
  };
  const p = read(PREF_KEY);
  const old = read(OLD_PREF_KEY); // formato anterior: {url, connect}
  const str = (v: unknown, d: string): string => (typeof v === "string" && v ? v : d);
  let pass = "";
  try {
    pass = sessionStorage.getItem(PASS_KEY) ?? "";
  } catch {
    // ignora
  }
  // Preferência salva com um broker padrão antigo → usa o padrão atual.
  const legacy = typeof p.mqttUrl === "string" && MQTT.legacyUrls.includes(p.mqttUrl);
  if (legacy) {
    delete p.mqttUrl;
    delete p.mqttUser;
  }
  const settings: LinkSettings = {
    transport: p.transport === "websocket" || p.transport === "mqtt" ? p.transport : WEBSOCKET.transport,
    wsUrl: str(p.wsUrl, str(old.url, WEBSOCKET.defaultUrl)),
    mqttUrl: str(p.mqttUrl, MQTT.url),
    mqttTopic: str(p.mqttTopic, MQTT.topic),
    mqttUser: str(p.mqttUser, MQTT.username),
    mqttPass: pass || MQTT.password,
  };
  const q = new URLSearchParams(location.search);
  if (q.get("ws")) {
    settings.transport = "websocket";
    settings.wsUrl = q.get("ws")!;
  } else if (q.get("mqtt")) {
    settings.transport = "mqtt";
    settings.mqttTopic = q.get("mqtt")!;
  }
  const connect = typeof p.connect === "boolean" ? p.connect : typeof old.connect === "boolean" ? old.connect : undefined;
  return { settings, connect: q.has("ws") || q.has("mqtt") ? true : connect };
}

export function saveLinkPrefs(settings: LinkSettings, connect: boolean): void {
  try {
    const { mqttPass, ...rest } = settings;
    localStorage.setItem(PREF_KEY, JSON.stringify({ ...rest, connect }));
    if (mqttPass) sessionStorage.setItem(PASS_KEY, mqttPass);
    else sessionStorage.removeItem(PASS_KEY);
  } catch {
    // armazenamento indisponível (modo privado): apenas não lembra
  }
}

// ------------------------------------------------------------ validação

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const validRpm = (v: unknown): v is number => isNum(v) && v >= 0 && v <= 3000;

function parseSensors(v: unknown): IoTSensors | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  return { encoder: s.encoder === true, mpu6050: s.mpu6050 === true, hcsr04: s.hcsr04 === true, lcd: s.lcd === true };
}

/**
 * Valida o JSON recebido (nunca executa nada dele). Retorna null se a
 * mensagem for inválida ou não tiver nada aproveitável.
 */
export function parseMessage(raw: string): Parsed | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;

  if (d.type === undefined) {
    const cmd = parseCommand(raw); // formato anterior
    return cmd ? { kind: "command", cmd, legacy: true } : null;
  }

  switch (d.type) {
    case "hello":
      return { kind: "hello", device: typeof d.device === "string" ? d.device.slice(0, 60) : "ESP32", sensors: parseSensors(d.sensors) };

    case "event":
      switch (d.event) {
        case "encoder":
          return validRpm(d.rpm) ? { kind: "command", cmd: { rpm: d.rpm }, legacy: false } : null;
        case "power":
          return typeof d.power === "boolean" ? { kind: "command", cmd: { power: d.power }, legacy: false } : null;
        case "direction":
          return d.direction === 1 || d.direction === -1
            ? { kind: "command", cmd: { direction: d.direction }, legacy: false }
            : null;
        case "explode":
          return { kind: "explode", exploded: true };
        case "assemble":
          return { kind: "explode", exploded: false };
        default:
          return null;
      }

    case "telemetry": {
      const v = (d.vibration && typeof d.vibration === "object" ? d.vibration : {}) as Record<string, unknown>;
      const mag = isNum(v.magnitude) ? Math.max(0, v.magnitude) : 0;
      let pct = isNum(v.percent) ? v.percent : mag * 100;
      pct = Math.min(100, Math.max(0, pct));
      const level =
        v.level === "normal" || v.level === "attention" || v.level === "high"
          ? v.level
          : pct > IOT.levels.high
            ? "high"
            : pct > IOT.levels.attention
              ? "attention"
              : "normal";
      const dist = isNum(d.distance) && d.distance >= 0 && d.distance < 1000 ? d.distance : null;
      return {
        kind: "telemetry",
        t: {
          vibrationPercent: pct,
          vibrationLevel: level,
          vibrationAxes: { x: isNum(v.x) ? v.x : 0, y: isNum(v.y) ? v.y : 0, z: isNum(v.z) ? v.z : 0, magnitude: mag },
          distance: dist,
          sensors: parseSensors(d.sensors),
        },
      };
    }

    default:
      return null;
  }
}

/** Formato anterior: {"rpm":1500,"power":true,"direction":1}. */
export function parseCommand(raw: string): RemoteCommand | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const cmd: RemoteCommand = {};

  const rpm = typeof d.rpm === "string" ? Number(d.rpm) : d.rpm;
  if (typeof rpm === "number" && Number.isFinite(rpm)) cmd.rpm = rpm;

  if (typeof d.power === "boolean") cmd.power = d.power;
  else if (d.power === 1 || d.power === 0) cmd.power = d.power === 1;

  if (d.direction === 1 || d.direction === -1) cmd.direction = d.direction;

  return Object.keys(cmd).length ? cmd : null;
}

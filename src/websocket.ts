import { WEBSOCKET } from "./config";
import type { DrillController, RemoteCommand } from "./drillController";
import type { WsStatus } from "./ui";

/**
 * Ponte WebSocket para um ESP32 (ou qualquer servidor) — preparação para IoT.
 *
 * Mensagens RECEBIDAS (JSON, todos os campos opcionais):
 *   {"rpm":1500,"power":true,"direction":1}
 *     rpm        0..3000
 *     power      true/false (aceita também 1/0)
 *     direction  1 = horário, −1 = anti-horário
 *
 * Mensagens ENVIADAS a cada mudança feita na página (painel, VR, teclado),
 * nunca como eco de um comando recebido:
 *   {"type":"state","rpm":1500,"power":true,"direction":1}
 * Ao conectar, a página envia {"type":"hello"} e o ESP32 responde com o seu
 * estado: o hardware (encoder) é a referência no momento da conexão.
 *
 * O comando é aplicado via DrillController.applyRemote(), o que atualiza a
 * animação e as duas interfaces (HTML e VR) automaticamente.
 */
export class Esp32Link {
  private ws: WebSocket | null = null;
  private url = "";
  private wantConnected = false;
  private retryMs = WEBSOCKET.reconnectBaseMs;
  private retryTimer: number | undefined;
  /** Verdadeiro enquanto aplica um comando do ESP32: evita devolver o eco. */
  private applyingRemote = false;

  constructor(
    private readonly drill: DrillController,
    private readonly onStatus: (s: WsStatus, detail?: string) => void,
  ) {
    // Só mudanças feitas AQUI (painel, VR, teclado) vão para o ESP32. Reenviar o
    // que veio dele criaria ecos atrasados que desfariam giros rápidos do encoder.
    drill.onChange((s) => {
      if (!this.applyingRemote) this.send({ type: "state", rpm: s.setpointRPM, power: s.power, direction: s.direction });
    });
  }

  get isActive(): boolean {
    return this.wantConnected;
  }

  connect(url: string): void {
    this.disconnect();
    if (!/^wss?:\/\//i.test(url)) {
      this.onStatus("error", "A URL deve começar com ws:// ou wss://");
      return;
    }
    if (location.protocol === "https:" && url.toLowerCase().startsWith("ws://")) {
      // Navegadores bloqueiam ws:// em páginas HTTPS (conteúdo misto).
      console.warn("[ws] Página HTTPS + ws:// será bloqueada pelo navegador. Use wss:// (ver README).");
    }
    this.url = url;
    this.wantConnected = true;
    this.retryMs = WEBSOCKET.reconnectBaseMs;
    this.open();
  }

  disconnect(): void {
    this.wantConnected = false;
    window.clearTimeout(this.retryTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.onStatus("disconnected");
  }

  /** Processa uma mensagem como se viesse do ESP32 (útil para testes). */
  handleMessage(raw: string): boolean {
    const cmd = parseCommand(raw);
    if (!cmd) {
      console.warn("[ws] Mensagem ignorada (JSON inválido ou sem campos conhecidos):", raw);
      return false;
    }
    this.applyingRemote = true;
    try {
      this.drill.applyRemote(cmd);
    } finally {
      this.applyingRemote = false;
    }
    return true;
  }

  private open(): void {
    this.onStatus("connecting", this.url);
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.onStatus("error", String(e));
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = WEBSOCKET.reconnectBaseMs;
      this.onStatus("connected", this.url);
      this.send({ type: "hello" });
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") this.handleMessage(ev.data);
    };
    ws.onerror = () => this.onStatus("error", "Falha na conexão com " + this.url);
    ws.onclose = () => {
      this.ws = null;
      if (this.wantConnected) this.scheduleReconnect();
      else this.onStatus("disconnected");
    };
  }

  private scheduleReconnect(): void {
    if (!this.wantConnected) return;
    window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => this.open(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, WEBSOCKET.reconnectMaxMs);
  }

  private send(obj: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }
}

/**
 * Resolve "auto" para a ponte do servidor Vite (mesma origem da página):
 * https://pc:5173 → wss://pc:5173/esp32 ; http://localhost:5173 → ws://localhost:5173/esp32
 */
export function resolveWsUrl(url: string): string {
  if (url !== "auto") return url;
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/esp32`;
}

const PREF_KEY = "furadeira.websocket";

/** Última URL usada e se o usuário deixou conectado (somente neste navegador). */
export function loadWsPreference(): { url?: string; connect?: boolean } {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function saveWsPreference(pref: { url: string; connect: boolean }): void {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(pref));
  } catch {
    // armazenamento indisponível (modo privado): apenas não lembra
  }
}

/** Valida e normaliza o JSON recebido. Retorna null se nada for aproveitável. */
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

/**
 * Vias de comunicação com o ESP32 (parte da camada IoT). As duas carregam
 * EXATAMENTE as mesmas mensagens JSON; só muda o caminho:
 *
 *   WebSocket local   página ⇄ servidor Vite (/esp32) ⇄ ESP32:81
 *   MQTT              página ⇄ broker (wss) ⇄ ESP32
 *                     tópicos <base>/up (placa→app), <base>/down (app→placa),
 *                     <base>/online ("1"/"0", retido; "0" = last will da placa)
 *
 * "open"  = via pronta (WebSocket aberto / broker conectado)
 * "peer"  = a PLACA está presente. No WebSocket é o próprio "open"; no MQTT o
 *           broker pode estar ok com a placa desligada, por isso existe o
 *           tópico /online.
 */
export interface TransportEvents {
  open: () => void;
  peer: (online: boolean) => void;
  message: (text: string) => void;
  close: (reason: string) => void;
}

export interface Transport {
  send: (text: string) => void;
  close: () => void;
}

export type LinkTarget =
  | { kind: "websocket"; url: string }
  | { kind: "mqtt"; url: string; topic: string; username?: string; password?: string };

export function describeTarget(t: LinkTarget): string {
  return t.kind === "websocket" ? t.url : `${t.url} · ${t.topic}`;
}

/** WebSocket direto (ou pela ponte /esp32 do servidor Vite). */
export function openWebSocket(url: string, ev: TransportEvents): Transport {
  const ws = new WebSocket(url);
  let closed = false;
  ws.onopen = () => {
    ev.open();
    ev.peer(true); // o servidor do outro lado É o ESP32
  };
  ws.onmessage = (m) => {
    if (typeof m.data === "string") ev.message(m.data);
  };
  ws.onclose = () => {
    if (!closed) ev.close("conexão encerrada");
    closed = true;
  };
  return {
    send: (text) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    },
    close: () => {
      closed = true;
      ws.onclose = null;
      ws.close();
    },
  };
}

/**
 * MQTT sobre WebSocket (mqtt.js, carregado só quando usado). A reconexão é
 * feita pelo Esp32Link (mesma política da outra via), não pelo mqtt.js.
 */
export function openMqtt(
  target: Extract<LinkTarget, { kind: "mqtt" }>,
  ev: TransportEvents,
): Transport {
  const base = target.topic.replace(/\/+$/, "");
  const topicUp = `${base}/up`;
  const topicDown = `${base}/down`;
  const topicOnline = `${base}/online`;
  let client: import("mqtt").MqttClient | null = null;
  let closed = false;
  const fail = (reason: string): void => {
    if (closed) return;
    closed = true;
    try {
      client?.end(true);
    } catch {
      // ignora
    }
    ev.close(reason);
  };

  import("mqtt")
    .then((mod) => {
      if (closed) return;
      const connect = (mod as unknown as { connect?: typeof mod.connect; default?: { connect: typeof mod.connect } }).connect ??
        (mod as unknown as { default: { connect: typeof mod.connect } }).default.connect;
      client = connect(target.url, {
        clientId: `furadeira-web-${Math.random().toString(16).slice(2, 10)}`,
        username: target.username || undefined,
        password: target.password || undefined,
        reconnectPeriod: 0, // reconexão controlada pelo Esp32Link
        connectTimeout: 8000,
        keepalive: 20,
        clean: true,
      });
      client.on("connect", () => {
        client!.subscribe([topicUp, topicOnline], { qos: 0 }, (err) => {
          if (err) return fail("falha ao assinar os tópicos: " + err.message);
          ev.open();
        });
      });
      client.on("message", (topic, payload) => {
        const text = payload.toString();
        if (topic === topicOnline) ev.peer(text.trim() === "1");
        else if (topic === topicUp) ev.message(text);
      });
      client.on("error", (err) => fail(err.message));
      client.on("close", () => fail("broker desconectado"));
    })
    .catch((e) => fail("não foi possível carregar o cliente MQTT: " + String(e)));

  return {
    send: (text) => {
      if (client?.connected) client.publish(topicDown, text, { qos: 0 });
    },
    close: () => {
      closed = true;
      try {
        client?.end(true);
      } catch {
        // ignora
      }
    },
  };
}

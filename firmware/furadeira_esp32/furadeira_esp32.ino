/*
  ============================================================================
   Furadeira WebXR — controle físico com encoder KY-040 via WebSocket
  ============================================================================
   Placa:   ESP32 D1 Mini (ESP32-WROOM-32). Também compila para ESP32-C3
            Super Mini (os pinos são escolhidos automaticamente abaixo).
   Encoder: KY-040 (CLK, DT, SW, +, GND)  →  alimente o "+" com 3V3, NÃO 5V.

   Comandos do encoder:
     girar            → aumenta/diminui o RPM (girar rápido = passos maiores)
     clique curto     → LIGA / DESLIGA
     clique longo     → INVERTE o sentido de rotação

   Protocolo (JSON, servidor WebSocket na porta 81):
     ESP32 → página:  {"rpm":1500,"power":true,"direction":1}
     página → ESP32:  {"type":"state","rpm":…,"power":…,"direction":…}
                      {"type":"hello"}   (a página pede o estado atual)
   O ESP32 é a "fonte da verdade" ao conectar: envia seu estado ao cliente.
   Mudanças feitas na página voltam para cá, então o encoder continua
   do valor certo, e são repassadas aos outros clientes (ex.: PC + Quest).

   Bibliotecas (Arduino IDE → Gerenciador de Bibliotecas):
     - "WebSockets"  de Markus Sattler (Links2004)   versão 2.4 ou superior
     - "ArduinoJson" de Benoit Blanchon              versão 7.x
   Núcleo: "esp32" da Espressif (Gerenciador de Placas), versão 2.x ou 3.x.
  ============================================================================
*/

#include <WiFi.h>
#include <ESPmDNS.h>
#include <WebSocketsServer.h>
#include <ArduinoJson.h>

// ----------------------------------------------------------------- REDE ----
const char* WIFI_SSID = "NOME_DA_SUA_REDE";   // mesma rede do PC / Meta Quest
const char* WIFI_PASS = "SENHA_DA_SUA_REDE";
// Se não conectar em 15 s, o ESP32 cria a própria rede (IP 192.168.4.1):
const char* AP_SSID   = "Furadeira-ESP32";
const char* AP_PASS   = "furadeira123";     // mínimo 8 caracteres
const char* MDNS_NAME = "furadeira";        // → furadeira.local
const uint16_t WS_PORT = 81;

// ---------------------------------------------------------------- PINOS ----
#if CONFIG_IDF_TARGET_ESP32C3
// ESP32-C3 Super Mini
const int  PIN_CLK = 5;
const int  PIN_DT  = 6;
const int  PIN_SW  = 7;
const int  PIN_LED = 8;      // LED azul da placa (aceso em nível baixo)
const bool LED_ACTIVE_LOW = true;
#else
// ESP32 D1 Mini (WROOM-32)
const int  PIN_CLK = 25;
const int  PIN_DT  = 26;
const int  PIN_SW  = 27;
const int  PIN_LED = 2;      // LED azul da placa
const bool LED_ACTIVE_LOW = false;
#endif

// ------------------------------------------------------------- AJUSTES ----
const int      RPM_MAX          = 3000;
const int      RPM_DEFAULT      = 1200;
const int      RPM_STEP_SLOW    = 50;    // RPM por "clique" girando devagar
const int      RPM_STEP_FAST    = 200;   // RPM por "clique" girando rápido
const uint32_t FAST_TURN_MS     = 45;    // cliques mais próximos que isso = rápido
// KY-040 típico = 4 transições por clique. Se for preciso girar 2 cliques
// para o RPM mudar uma vez, use 2.
const int      STEPS_PER_DETENT = 4;
const bool     INVERT_ENCODER   = false; // true se girar para a direita diminuir
const uint32_t DEBOUNCE_MS      = 30;
const uint32_t LONG_PRESS_MS    = 700;
const uint32_t SEND_INTERVAL_MS = 40;    // limita o envio enquanto gira

// --------------------------------------------------------------- ESTADO ----
struct DrillState {
  int  rpm;
  bool power;
  int  direction;  // 1 = horário, -1 = anti-horário
};
DrillState st = {RPM_DEFAULT, false, 1};
bool       pendingSend = false;
uint32_t   lastSendMs  = 0;

WebSocketsServer ws(WS_PORT);

// ------------------------------------------------- ENCODER (interrupção) ----
// Decodificação em quadratura por tabela: robusta contra trepidação, pois
// transições inválidas valem 0.
volatile int32_t encDelta = 0;
volatile uint8_t encPrev  = 0;
portMUX_TYPE encMux = portMUX_INITIALIZER_UNLOCKED;
const int8_t QDEC[16] = {0, -1, 1, 0, 1, 0, 0, -1, -1, 0, 0, 1, 0, 1, -1, 0};

void IRAM_ATTR onEncoderEdge() {
  uint8_t s = (digitalRead(PIN_CLK) << 1) | digitalRead(PIN_DT);
  portENTER_CRITICAL_ISR(&encMux);
  encPrev = ((encPrev << 2) | s) & 0x0F;
  encDelta += QDEC[encPrev];
  portEXIT_CRITICAL_ISR(&encMux);
}

/** Retorna quantos "cliques" (detents) ocorreram desde a última leitura. */
int32_t takeDetents() {
  portENTER_CRITICAL(&encMux);
  int32_t d = encDelta / STEPS_PER_DETENT;
  encDelta -= d * STEPS_PER_DETENT;
  portEXIT_CRITICAL(&encMux);
  return INVERT_ENCODER ? -d : d;
}

// ------------------------------------------------------------ AUXILIARES ----
void updateLed() {
  digitalWrite(PIN_LED, (st.power != LED_ACTIVE_LOW) ? HIGH : LOW);
}

int formatState(char* buf, size_t n) {
  return snprintf(buf, n, "{\"rpm\":%d,\"power\":%s,\"direction\":%d}",
                  st.rpm, st.power ? "true" : "false", st.direction);
}

void sendStateTo(uint8_t num) {
  char buf[80];
  formatState(buf, sizeof(buf));
  ws.sendTXT(num, buf);
}

/** Envia o estado a todos os clientes, exceto `except` (255 = nenhum). */
void broadcastState(uint8_t except = 255) {
  char buf[80];
  formatState(buf, sizeof(buf));
  for (uint8_t i = 0; i < WEBSOCKETS_SERVER_CLIENT_MAX; i++) {
    if (i != except && ws.clientIsConnected(i)) ws.sendTXT(i, buf);
  }
}

void markChanged(const char* why) {
  updateLed();
  pendingSend = true;
  Serial.printf("[local] %-10s rpm=%4d  %s  %s\n", why, st.rpm,
                st.power ? "LIGADA   " : "DESLIGADA", st.direction > 0 ? "horario" : "anti-horario");
}

// --------------------------------------------------------------- BOTÃO ----
bool     btnStable  = HIGH;
bool     btnLast    = HIGH;
uint32_t btnEdgeMs  = 0;
uint32_t btnDownMs  = 0;
bool     longFired  = false;

void handleButton() {
  bool r = digitalRead(PIN_SW);
  uint32_t now = millis();
  if (r != btnLast) {
    btnLast = r;
    btnEdgeMs = now;
  }
  if (now - btnEdgeMs > DEBOUNCE_MS && r != btnStable) {
    btnStable = r;
    if (btnStable == LOW) {            // apertou
      btnDownMs = now;
      longFired = false;
    } else if (!longFired) {           // soltou antes do tempo longo → clique curto
      st.power = !st.power;
      markChanged(st.power ? "LIGAR" : "DESLIGAR");
    }
  }
  if (btnStable == LOW && !longFired && now - btnDownMs >= LONG_PRESS_MS) {
    longFired = true;                  // clique longo (dispara sem precisar soltar)
    st.direction = -st.direction;
    markChanged("INVERTER");
  }
}

// ------------------------------------------------------------- ENCODER ----
uint32_t lastDetentMs = 0;

void handleEncoder() {
  int32_t d = takeDetents();
  if (d == 0) return;
  uint32_t now = millis();
  int step = (now - lastDetentMs < FAST_TURN_MS) ? RPM_STEP_FAST : RPM_STEP_SLOW;
  lastDetentMs = now;
  int rpm = constrain(st.rpm + (int)d * step, 0, RPM_MAX);
  if (rpm != st.rpm) {
    st.rpm = rpm;
    markChanged("RPM");
  }
}

// ----------------------------------------------------------- WEBSOCKET ----
void onWsEvent(uint8_t num, WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.printf("[ws] cliente %u conectado (%s)\n", num, ws.remoteIP(num).toString().c_str());
      sendStateTo(num);  // ESP32 é a referência ao conectar
      break;

    case WStype_DISCONNECTED:
      Serial.printf("[ws] cliente %u desconectado\n", num);
      break;

    case WStype_TEXT: {
      JsonDocument doc;
      if (deserializeJson(doc, payload, length)) return;  // JSON inválido: ignora

      const char* t = doc["type"] | "";
      if (strcmp(t, "hello") == 0) {
        sendStateTo(num);
        return;
      }

      DrillState n = st;
      if (doc["rpm"].is<float>() || doc["rpm"].is<int>()) {
        n.rpm = constrain((int)lroundf(doc["rpm"].as<float>()), 0, RPM_MAX);
      }
      if (doc["power"].is<bool>()) n.power = doc["power"].as<bool>();
      else if (doc["power"].is<int>()) n.power = doc["power"].as<int>() != 0;
      if (doc["direction"].is<int>()) {
        int dir = doc["direction"].as<int>();
        if (dir == 1 || dir == -1) n.direction = dir;
      }

      if (n.rpm != st.rpm || n.power != st.power || n.direction != st.direction) {
        st = n;
        updateLed();
        Serial.printf("[ws %u] rpm=%4d  %s  %s\n", num, st.rpm,
                      st.power ? "LIGADA   " : "DESLIGADA", st.direction > 0 ? "horario" : "anti-horario");
        broadcastState(num);  // mantém os outros clientes em sincronia
      }
      break;
    }

    default:
      break;
  }
}

// --------------------------------------------------------------- WI-FI ----
void setupWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // menor latência
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("[wifi] conectando a \"%s\"", WIFI_SSID);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 15000) {
    delay(300);
    Serial.print('.');
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[wifi] conectado. IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    WiFi.mode(WIFI_AP);
    WiFi.softAP(AP_SSID, AP_PASS);
    Serial.printf("[wifi] sem rede. Ponto de acesso \"%s\" (senha %s), IP: %s\n",
                  AP_SSID, AP_PASS, WiFi.softAPIP().toString().c_str());
  }

  if (MDNS.begin(MDNS_NAME)) {
    MDNS.addService("ws", "tcp", WS_PORT);
    Serial.printf("[mdns] %s.local\n", MDNS_NAME);
  }
}

// ------------------------------------------------------------ SETUP/LOOP ----
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n=== Furadeira WebXR — encoder KY-040 ===");

  pinMode(PIN_CLK, INPUT_PULLUP);  // o KY-040 já tem pull-ups; os internos não atrapalham
  pinMode(PIN_DT, INPUT_PULLUP);
  pinMode(PIN_SW, INPUT_PULLUP);   // o pino SW do KY-040 normalmente NÃO tem pull-up
  pinMode(PIN_LED, OUTPUT);
  updateLed();

  encPrev = (digitalRead(PIN_CLK) << 1) | digitalRead(PIN_DT);
  attachInterrupt(digitalPinToInterrupt(PIN_CLK), onEncoderEdge, CHANGE);
  attachInterrupt(digitalPinToInterrupt(PIN_DT), onEncoderEdge, CHANGE);

  setupWifi();

  ws.begin();
  ws.onEvent(onWsEvent);
  ws.enableHeartbeat(15000, 3000, 2);  // derruba clientes "fantasmas"
  Serial.printf("[ws] servidor em ws://%s:%u\n",
                (WiFi.getMode() == WIFI_AP ? WiFi.softAPIP() : WiFi.localIP()).toString().c_str(), WS_PORT);
}

void loop() {
  ws.loop();
  handleEncoder();
  handleButton();

  // Envio agrupado: girar rápido não inunda a rede.
  if (pendingSend && millis() - lastSendMs >= SEND_INTERVAL_MS) {
    pendingSend = false;
    lastSendMs = millis();
    broadcastState();
  }
}

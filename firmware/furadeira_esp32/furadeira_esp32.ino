/*
  ============================================================================
   DIGITAL TWIN — Furadeira WebXR  ·  firmware do ESP32 (v2.0)
  ============================================================================
   Placa:   uPesy ESP32-C3 Mini  (ESP32-C3, 3,3 V, USB nativo)
            Arduino IDE: placa "ESP32C3 Dev Module" (ou "uPesy ESP32C3 Mini"),
            "USB CDC On Boot: Enabled" (senão o Monitor Serial fica mudo).

   Periféricos e função de cada um:
     KY-040   → RPM (gira) · liga/desliga (clique) · inverte (clique longo)
     MPU6050  → vibração real (I2C)          → microvibração no gêmeo digital
     HC-SR04  → proximidade da mão           → vista explodida (≤3 cm) / monta (≥5 cm)
     LCD 16x2 I2C (PCF8574)                  ← feedback de status e interações

   COMUNICAÇÃO (as duas ao mesmo tempo; a página usa a que estiver configurada):
     • MQTT     — via broker (rede IoT da escola, internet, GitHub Pages)
                  tópicos <MQTT_TOPIC>/up (placa→app), /down (app→placa),
                  /online ("1"/"0", retido; "0" é o last will se a placa cair)
     • WebSocket local na porta 81 — ponte /esp32 do "npm run dev"

   A APLICAÇÃO WEB É A FONTE DO ESTADO. O ESP32 envia comandos/telemetria;
   a aplicação aplica com as funções que já existem e devolve {"type":"status"}.
   Se qualquer periférico faltar, o resto continua funcionando (e a aplicação
   funciona mesmo sem o ESP32).

   ---------------------------------------------------------------------------
   PINAGEM — uPesy ESP32-C3 Mini  (CONFIRMADA NOS TESTES DA BANCADA)
   ---------------------------------------------------------------------------
     GPIO 1  ↔ I2C SDA  (MPU6050 + LCD)   — scanner encontrou o MPU6050 em 0x68
     GPIO 0  ↔ I2C SCL  (MPU6050 + LCD)
     GPIO 3  ← HC-SR04 ECHO       !!! via DIVISOR: ECHO─1kΩ─┬─GPIO3
                                                        2kΩ
                                                         GND   (5 V → 3,3 V)
     GPIO 4  → HC-SR04 TRIG       (3,3 V é aceito como nível alto pelo TRIG)
     GPIO 5  ← KY-040 CLK
     GPIO 6  ← KY-040 DT
     GPIO 7  ← KY-040 SW          (pull-up interno)
     GPIO 10    reservado (servo, uso futuro)
     Livres: GPIO 2, 8, 9 (strapping: não puxar para GND no boot), 20, 21
     Não usar: GPIO 18/19 (USB)

   Alimentação:
     KY-040 "+"  → 3V3          MPU6050 VCC → 3V3 (GY-521 aceita 3–5 V)
     HC-SR04 VCC → 5V (VBUS)    LCD VCC     → 5V  (contraste adequado)
   ATENÇÃO I2C: a plaquinha PCF8574 do LCD tem pull-ups para o SEU VCC. Com
   o LCD em 5 V, SDA/SCL sobem para 5 V — acima do limite do ESP32-C3.
   Use um conversor de nível I2C (BSS138, 4 canais) entre o ESP32 e o LCD,
   ou remova os 2 resistores de pull-up da plaquinha (o GY-521 já tem pull-ups
   para 3,3 V). Ver firmware/README.md.

   Bibliotecas (Gerenciador de Bibliotecas):
     - "WebSockets"  de Markus Sattler (Links2004)  ≥ 2.4
     - "ArduinoJson" de Benoit Blanchon             7.x
     - "PubSubClient" de Nick O'Leary               2.8 (MQTT)
   O LCD e o MPU6050 usam drivers próprios (abaixo), sem bibliotecas extras,
   e os endereços I2C são DETECTADOS por varredura (nada é assumido).
  ============================================================================
*/

#include <WiFi.h>
#include <ESPmDNS.h>
#include <Wire.h>
#include <WebSocketsServer.h>
#include <PubSubClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <utility>

// ============================================================ CONFIGURAÇÃO ===
#define IOT_DEBUG 1  // 1 = log no Monitor Serial ([KY040], [MPU6050]…); 0 = silencioso

// Liga/desliga cada periférico (testes incrementais: habilite um por vez).
#define ENABLE_ENCODER 1
#define ENABLE_MPU6050 1
#define ENABLE_HCSR04 1
#define ENABLE_LCD 1

// ---- Rede (mesma rede 2,4 GHz do PC / Meta Quest) ----
// As credenciais ficam em "secrets.h" (mesma pasta do sketch, ignorado pelo
// git: o repositório é público). Modelo: secrets.example.h.
#if __has_include("secrets.h")
#include "secrets.h"
#else
#warning "secrets.h não encontrado: copie secrets.example.h para secrets.h e preencha o Wi-Fi"
const char* WIFI_SSID = "NOME_DA_SUA_REDE";
const char* WIFI_PASSWORD = "SENHA_DA_SUA_REDE";
#endif
const char* AP_SSID = "Furadeira-ESP32";  // rede própria se o Wi-Fi falhar (IP 192.168.4.1)
const char* AP_PASS = "furadeira123";
const char* MDNS_NAME = "furadeira";      // → furadeira.local
const uint16_t WS_PORT = 81;
const uint32_t WIFI_TIMEOUT_MS = 15000;

// ---- MQTT ----
// Broker padrão: HiveMQ público (sem conta). O tópico abaixo é exclusivo desta
// furadeira — a aplicação web precisa usar o MESMO tópico. Em broker público
// qualquer um que saiba o tópico pode publicar: para uso contínuo prefira um
// broker com usuário/senha (HiveMQ Cloud, Mosquitto da escola) e defina
// MQTT_USER / MQTT_PASS no secrets.h.
#define MQTT_ENABLED 1
const char* MQTT_HOST = "broker.hivemq.com";
const uint16_t MQTT_PORT = 8883;  // 8883 = TLS · 1883 = sem criptografia
#define MQTT_TLS 1                // 1 = TLS (sem validar o certificado: criptografa, mas não autentica o broker)
const char* MQTT_TOPIC = "senai-furadeira/d3f5f010";
#ifndef MQTT_USER
#define MQTT_USER ""
#endif
#ifndef MQTT_PASS
#define MQTT_PASS ""
#endif
const uint32_t MQTT_RETRY_MS = 8000;      // nova tentativa de conexão com o broker
const uint32_t MQTT_APP_TIMEOUT_MS = 15000; // sem mensagem da app por este tempo = app desconectada

// ---- Pinos ----
#if CONFIG_IDF_TARGET_ESP32C3
// Pinagem confirmada nos testes.
const int PIN_I2C_SDA = 1;  // MPU6050: scanner encontrou 0x68
const int PIN_I2C_SCL = 0;
const int PIN_US_ECHO = 3;  // via divisor 1 kΩ / 2 kΩ
const int PIN_US_TRIG = 4;
const int PIN_ENC_CLK = 5;
const int PIN_ENC_DT = 6;
const int PIN_ENC_SW = 7;
const int PIN_SERVO = 10;   // reservado (servo, uso futuro): não utilizado ainda
#else
#error "Firmware configurado para o uPesy ESP32-C3 Mini. Para outra placa, defina os pinos aqui."
#endif

// ---- KY-040 / RPM ----
const int RPM_MIN = 0;
const int RPM_MAX = 3000;
const int RPM_STEP = 50;              // RPM por clique
const bool ENCODER_ACCEL = false;     // true: girar rápido usa RPM_STEP_FAST
const int RPM_STEP_FAST = 200;
const uint32_t FAST_TURN_MS = 45;
const int STEPS_PER_DETENT = 4;       // KY-040 típico = 4 (use 2 se precisar de 2 cliques por passo)
const bool INVERT_ENCODER = false;    // true se girar no sentido horário diminuir
const uint32_t BTN_DEBOUNCE_MS = 30;
const uint32_t BTN_LONG_MS = 700;
const uint32_t ENCODER_SEND_MS = 40;  // agrupa giros rápidos (máx. 25 msg/s)
const uint32_t ENCODER_HOLD_MS = 500; // após girar, ignora "status" da app por este tempo

// ---- MPU6050 / vibração ----
const uint32_t MPU_SAMPLE_MS = 10;     // 100 Hz de amostragem
const uint32_t VIB_SEND_MS = 50;       // telemetria até 20 Hz (só se mudar)
const float VIB_DEADZONE_G = 0.015f;   // abaixo disso = sensor parado
const float VIB_FULL_SCALE_G = 0.35f;  // RMS dinâmico (g) que corresponde a 100 %
const float VIB_ATTENTION_PCT = 30.0f; // NORMAL ≤ 30 % < ATENÇÃO ≤ 70 % < ALTA
const float VIB_HIGH_PCT = 70.0f;
const float VIB_HYST_PCT = 5.0f;       // histerese entre faixas
const uint16_t MPU_CALIB_SAMPLES = 150;

// ---- HC-SR04 / proximidade ----
const uint32_t US_PERIOD_MS = 100;       // 10 Hz
const uint32_t US_TIMEOUT_US = 30000;    // > ~5 m: sem objeto
const float US_EXPLODE_CM = 3.0f;        // ≤ → vista explodida
const float US_ASSEMBLE_CM = 5.0f;       // ≥ → monta (entre 3 e 5: mantém)
const uint8_t US_CONFIRM_READS = 3;      // leituras consecutivas para confirmar
const float US_SHOW_CM = 15.0f;          // abaixo disso o LCD mostra a distância
const float US_MIN_VALID_CM = 1.5f;
const float US_MAX_VALID_CM = 400.0f;

// ---- LCD ----
const uint8_t LCD_COLS = 16;
const uint8_t LCD_ROWS = 2;
const uint32_t LCD_TICK_MS = 100;
const uint32_t LCD_ROTATE_MS = 3000;     // troca de tela de status
const uint32_t LCD_RETRY_MS = 5000;      // tenta reencontrar o LCD

// ================================================================ DEBUG ======
#if IOT_DEBUG
#define DBG(...) Serial.printf(__VA_ARGS__)
#else
#define DBG(...) \
  do {           \
  } while (0)
#endif

// ======================================================= ESTADO GLOBAL =======
WebSocketsServer ws(WS_PORT);

enum Prio : uint8_t { P_LOW = 0, P_NORMAL = 1, P_MEDIUM = 2, P_HIGH = 3 };

struct AppState {  // estado CONFIRMADO pela aplicação (fonte da verdade)
  bool known = false;
  int rpm = 1200;
  bool power = false;
  int direction = 1;
  bool exploded = false;
} app;

bool wifiUp = false;
bool apMode = false;
uint8_t wsClients = 0;      // aplicações conectadas pelo WebSocket local
bool mqttAppAlive = false;  // aplicação ativa pelo MQTT (batimento a cada 5 s)
inline bool appConnected() { return wsClients > 0 || mqttAppAlive; }

int rpmRequested = 1200;  // valor local do encoder (enviado à app)
uint32_t lastEncoderMs = 0;

// Sensores: presentes/funcionando (para a seção "IoT / Hardware" da app).
bool encoderOnline = ENABLE_ENCODER;
bool mpuOnline = false;
bool usOnline = false;
bool lcdOnline = false;

// Vibração (saída filtrada).
float vibPct = 0, vibX = 0, vibY = 0, vibZ = 0, vibG = 0;
uint8_t vibLevel = 0;  // 0 normal, 1 atenção, 2 alta
// Proximidade.
float distanceCm = -1;  // -1 = sem objeto / fora de alcance
bool handExploded = false;

void lcdShow(const char* l1, const char* l2, Prio p, uint32_t ms);
void sendJson(const char* json);
const char* vibLevelName(uint8_t lv, bool ascii);

// ============================================================================
//                                   WI-FI
// ============================================================================
uint32_t wifiStartMs = 0;

void setupWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // menor latência
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  wifiStartMs = millis();
  lcdShow("CONECTANDO", "WIFI...", P_NORMAL, WIFI_TIMEOUT_MS);
  DBG("[WIFI] conectando a \"%s\"\n", WIFI_SSID);
}

/** Máquina de estados não bloqueante: STA → (timeout) → ponto de acesso. */
void handleWiFi() {
  static bool mdnsStarted = false;
  if (!wifiUp && !apMode) {
    if (WiFi.status() == WL_CONNECTED) {
      wifiUp = true;
      DBG("[WIFI] conectado. IP %s\n", WiFi.localIP().toString().c_str());
      lcdShow("WIFI", "CONECTADO", P_NORMAL, 1500);
    } else if (millis() - wifiStartMs > WIFI_TIMEOUT_MS) {
      WiFi.mode(WIFI_AP);
      WiFi.softAP(AP_SSID, AP_PASS);
      apMode = true;
      wifiUp = true;
      DBG("[WIFI] sem rede: ponto de acesso \"%s\" IP %s\n", AP_SSID, WiFi.softAPIP().toString().c_str());
      lcdShow("WIFI: MODO AP", "192.168.4.1", P_HIGH, 4000);
    }
  } else if (!apMode && WiFi.status() != WL_CONNECTED && wifiUp) {
    wifiUp = false;  // caiu: o driver reconecta sozinho
    wifiStartMs = millis();
    DBG("[WIFI] conexão perdida, reconectando\n");
    lcdShow("WIFI", "RECONECTANDO...", P_HIGH, 3000);
  }
  if (wifiUp && !mdnsStarted && MDNS.begin(MDNS_NAME)) {
    MDNS.addService("ws", "tcp", WS_PORT);
    mdnsStarted = true;
    DBG("[WIFI] mDNS %s.local\n", MDNS_NAME);
  }
}

String localIp() {
  return apMode ? WiFi.softAPIP().toString() : WiFi.localIP().toString();
}

// ============================================================================
//                                LCD 16x2 I2C
// Driver mínimo HD44780 via PCF8574 (P0=RS P1=RW P2=EN P3=luz P4..P7=D4..D7).
// Escreve só os caracteres que mudaram (cada atualização custa poucos ms).
// ============================================================================
uint8_t lcdAddr = 0;
char lcdShadow[LCD_ROWS][LCD_COLS + 1];
uint32_t lcdRetryMs = 0;

bool i2cPresent(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

bool lcdExp(uint8_t v) {
  Wire.beginTransmission(lcdAddr);
  Wire.write(v | 0x08);  // luz de fundo sempre ligada
  return Wire.endTransmission() == 0;
}

bool lcdNibble(uint8_t nib, uint8_t rs) {
  uint8_t v = (nib << 4) | rs;
  bool ok = lcdExp(v | 0x04);
  delayMicroseconds(1);
  ok &= lcdExp(v);
  delayMicroseconds(45);
  return ok;
}

bool lcdByte(uint8_t b, uint8_t rs) {
  return lcdNibble(b >> 4, rs) && lcdNibble(b & 0x0F, rs);
}

bool lcdInit() {
  // Varre os endereços típicos de PCF8574 (0x20–0x27) e PCF8574A (0x38–0x3F).
  lcdAddr = 0;
  for (uint8_t a : {0x27, 0x3F}) if (i2cPresent(a)) { lcdAddr = a; break; }
  for (uint8_t a = 0x20; !lcdAddr && a <= 0x27; a++) if (i2cPresent(a)) lcdAddr = a;
  for (uint8_t a = 0x38; !lcdAddr && a <= 0x3F; a++) if (i2cPresent(a)) lcdAddr = a;
  if (!lcdAddr) return false;
  // Sequência de inicialização em 4 bits (delays curtos, só na partida).
  delay(50);
  lcdNibble(0x03, 0); delay(5);
  lcdNibble(0x03, 0); delayMicroseconds(150);
  lcdNibble(0x03, 0); delayMicroseconds(150);
  lcdNibble(0x02, 0);
  bool ok = lcdByte(0x28, 0)      // 4 bits, 2 linhas, 5x8
            && lcdByte(0x0C, 0)   // display on, cursor off
            && lcdByte(0x06, 0)   // incremento
            && lcdByte(0x01, 0);  // limpa
  delay(2);
  memset(lcdShadow, ' ', sizeof(lcdShadow));
  for (auto& r : lcdShadow) r[LCD_COLS] = 0;
  DBG("[LCD] %s no endereço 0x%02X\n", ok ? "pronto" : "falhou", lcdAddr);
  return ok;
}

void setupLCD() {
#if ENABLE_LCD
  lcdOnline = lcdInit();
  if (!lcdOnline) DBG("[LCD] não encontrado (a aplicação continua normalmente)\n");
#endif
}

/** Escreve uma linha (preenche com espaços) alterando só o necessário. */
void lcdLine(uint8_t row, const char* text) {
  if (!lcdOnline) return;
  char buf[LCD_COLS + 1];
  snprintf(buf, sizeof(buf), "%-16.16s", text);
  for (uint8_t c = 0; c < LCD_COLS; c++) {
    if (lcdShadow[row][c] == buf[c]) continue;
    uint8_t c0 = c;
    while (c < LCD_COLS && lcdShadow[row][c] != buf[c]) c++;
    bool ok = lcdByte(0x80 | (row ? 0x40 : 0x00) | c0, 0);
    for (uint8_t i = c0; ok && i < c; i++) ok = lcdByte(buf[i], 1);
    if (!ok) {
      lcdOnline = false;  // LCD sumiu do barramento: tenta de novo depois
      lcdRetryMs = millis();
      DBG("[LCD] erro de comunicação\n");
      return;
    }
    memcpy(&lcdShadow[row][c0], &buf[c0], c - c0);
    c--;
  }
}

// ---- Gerenciador de mensagens com prioridade --------------------------------
struct LcdMsg {
  char l1[LCD_COLS + 1];
  char l2[LCD_COLS + 1];
  Prio prio;
  uint32_t until;
  bool active;
} lcdMsg = {"", "", P_LOW, 0, false};

/**
 * Mostra uma mensagem por `ms`. Uma mensagem só é substituída por outra de
 * prioridade IGUAL OU MAIOR enquanto estiver no ar.
 */
void lcdShow(const char* l1, const char* l2, Prio p, uint32_t ms) {
  bool expired = !lcdMsg.active || (int32_t)(millis() - lcdMsg.until) >= 0;
  if (!expired && p < lcdMsg.prio) return;
  snprintf(lcdMsg.l1, sizeof(lcdMsg.l1), "%s", l1);
  snprintf(lcdMsg.l2, sizeof(lcdMsg.l2), "%s", l2);
  lcdMsg.prio = p;
  lcdMsg.until = millis() + ms;
  lcdMsg.active = true;
  DBG("[LCD] %s | %s\n", l1, l2);
}

/** Tela padrão (prioridade baixa) quando não há mensagem no ar. */
void lcdStatusScreen(char* l1, char* l2) {
  static uint8_t page = 0;
  static uint32_t pageMs = 0;
  if (millis() - pageMs > LCD_ROTATE_MS) {
    pageMs = millis();
    page++;
  }
  if (!wifiUp) {
    strcpy(l1, "CONECTANDO");
    strcpy(l2, "WIFI...");
  } else if (!appConnected()) {
    if (page % 2) {
      strcpy(l1, "AGUARDANDO");
      strcpy(l2, "APLICACAO");
    } else {
      strcpy(l1, apMode ? "IP (MODO AP)" : "ESP32 ONLINE IP");
      snprintf(l2, LCD_COLS + 1, "%s", localIp().c_str());
    }
  } else {
    switch (page % 4) {
      case 0:
        strcpy(l1, "DIGITAL TWIN");
        strcpy(l2, "ONLINE");
        break;
      case 1:
        snprintf(l1, LCD_COLS + 1, "RPM %s", app.power ? "(LIGADA)" : "(PARADA)");
        snprintf(l2, LCD_COLS + 1, "%d %s", app.rpm, app.direction > 0 ? "HORARIO" : "ANTI-HOR");
        break;
      case 2:
        strcpy(l1, "VIBRACAO");
        if (mpuOnline) snprintf(l2, LCD_COLS + 1, "%s %d%%", vibLevelName(vibLevel, true), (int)roundf(vibPct));
        else strcpy(l2, "SEM SENSOR");
        break;
      default:
        strcpy(l1, "DISTANCIA");
        if (!usOnline) strcpy(l2, "SEM SENSOR");
        else if (distanceCm < 0) strcpy(l2, "-- CM");
        else snprintf(l2, LCD_COLS + 1, "%.1f CM", distanceCm);
        break;
    }
  }
}

void updateLCD() {
#if ENABLE_LCD
  static uint32_t last = 0;
  if (millis() - last < LCD_TICK_MS) return;
  last = millis();
  if (!lcdOnline) {
    if (millis() - lcdRetryMs > LCD_RETRY_MS) {
      lcdRetryMs = millis();
      lcdOnline = lcdInit();
    }
    return;
  }
  char l1[LCD_COLS + 1], l2[LCD_COLS + 1];
  if (lcdMsg.active && (int32_t)(millis() - lcdMsg.until) < 0) {
    strcpy(l1, lcdMsg.l1);
    strcpy(l2, lcdMsg.l2);
  } else {
    lcdMsg.active = false;
    lcdStatusScreen(l1, l2);
  }
  lcdLine(0, l1);
  lcdLine(1, l2);
#endif
}

// ============================================================================
//                                   KY-040
// ============================================================================
volatile int32_t encDelta = 0;
volatile uint8_t encPrev = 0;
portMUX_TYPE encMux = portMUX_INITIALIZER_UNLOCKED;
// Decodificação em quadratura por tabela: transições inválidas (trepidação) valem 0.
const int8_t QDEC[16] = {0, -1, 1, 0, 1, 0, 0, -1, -1, 0, 0, 1, 0, 1, -1, 0};

void IRAM_ATTR onEncoderEdge() {
  uint8_t s = (digitalRead(PIN_ENC_CLK) << 1) | digitalRead(PIN_ENC_DT);
  portENTER_CRITICAL_ISR(&encMux);
  encPrev = ((encPrev << 2) | s) & 0x0F;
  encDelta += QDEC[encPrev];
  portEXIT_CRITICAL_ISR(&encMux);
}

void setupEncoder() {
#if ENABLE_ENCODER
  pinMode(PIN_ENC_CLK, INPUT_PULLUP);  // o módulo já tem pull-ups em CLK/DT
  pinMode(PIN_ENC_DT, INPUT_PULLUP);
  pinMode(PIN_ENC_SW, INPUT_PULLUP);   // o SW do KY-040 normalmente NÃO tem pull-up
  encPrev = (digitalRead(PIN_ENC_CLK) << 1) | digitalRead(PIN_ENC_DT);
  attachInterrupt(digitalPinToInterrupt(PIN_ENC_CLK), onEncoderEdge, CHANGE);
  attachInterrupt(digitalPinToInterrupt(PIN_ENC_DT), onEncoderEdge, CHANGE);
#endif
}

int32_t takeDetents() {
  portENTER_CRITICAL(&encMux);
  int32_t d = encDelta / STEPS_PER_DETENT;
  encDelta -= d * STEPS_PER_DETENT;
  portEXIT_CRITICAL(&encMux);
  return INVERT_ENCODER ? -d : d;
}

bool encoderPending = false;
uint32_t encoderSentMs = 0;
int lcdShownRpm = -1;

void readEncoder() {
#if ENABLE_ENCODER
  int32_t d = takeDetents();
  uint32_t now = millis();
  if (d != 0) {
    int step = (ENCODER_ACCEL && now - lastEncoderMs < FAST_TURN_MS) ? RPM_STEP_FAST : RPM_STEP;
    int r = constrain(rpmRequested + (int)d * step, RPM_MIN, RPM_MAX);  // nunca < 0 nem > 3000
    lastEncoderMs = now;
    if (r != rpmRequested) {
      rpmRequested = r;
      encoderPending = true;
      DBG("[KY040] RPM: %d\n", r);
    }
  }
  // Envio agrupado: girar rápido não inunda a rede.
  if (encoderPending && now - encoderSentMs >= ENCODER_SEND_MS) {
    encoderPending = false;
    encoderSentMs = now;
    char json[64];
    snprintf(json, sizeof(json), "{\"type\":\"event\",\"event\":\"encoder\",\"rpm\":%d}", rpmRequested);
    sendJson(json);
  }
  // Feedback imediato no LCD (só quando o valor muda).
  if (rpmRequested != lcdShownRpm && now - lastEncoderMs < 50) {
    lcdShownRpm = rpmRequested;
    char l2[LCD_COLS + 1];
    snprintf(l2, sizeof(l2), "%d RPM", rpmRequested);
    lcdShow("RPM", l2, P_NORMAL, 2000);
  }
#endif
}

// Botão: clique curto liga/desliga, clique longo inverte o sentido (a partir do
// estado CONFIRMADO pela aplicação).
void readButton() {
#if ENABLE_ENCODER
  static bool stable = HIGH, lastRaw = HIGH, longFired = false;
  static uint32_t edgeMs = 0, downMs = 0;
  bool r = digitalRead(PIN_ENC_SW);
  uint32_t now = millis();
  if (r != lastRaw) {
    lastRaw = r;
    edgeMs = now;
  }
  if (now - edgeMs > BTN_DEBOUNCE_MS && r != stable) {
    stable = r;
    if (stable == LOW) {
      downMs = now;
      longFired = false;
    } else if (!longFired) {
      bool on = !app.power;
      char json[64];
      snprintf(json, sizeof(json), "{\"type\":\"event\",\"event\":\"power\",\"power\":%s}", on ? "true" : "false");
      sendJson(json);
      DBG("[KY040] botão: %s\n", on ? "LIGAR" : "DESLIGAR");
      lcdShow("MAQUINA", appConnected() ? (on ? "LIGANDO..." : "DESLIGANDO...") : "SEM APLICACAO", P_NORMAL, 1500);
    }
  }
  if (stable == LOW && !longFired && now - downMs >= BTN_LONG_MS) {
    longFired = true;
    int dir = -app.direction;
    char json[64];
    snprintf(json, sizeof(json), "{\"type\":\"event\",\"event\":\"direction\",\"direction\":%d}", dir);
    sendJson(json);
    DBG("[KY040] clique longo: inverter\n");
    lcdShow("SENTIDO", dir > 0 ? "HORARIO" : "ANTI-HORARIO", P_NORMAL, 1500);
  }
#endif
}

// ============================================================================
//                         MPU6050 (driver I2C mínimo)
// ============================================================================
uint8_t mpuAddr = 0;
uint32_t mpuRetryMs = 0;
uint8_t mpuFails = 0;

bool mpuWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(mpuAddr);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

bool mpuInit() {
  mpuAddr = 0;
  for (uint8_t a : {0x68, 0x69}) {
    Wire.beginTransmission(a);
    Wire.write(0x75);  // WHO_AM_I
    if (Wire.endTransmission(false) != 0) continue;
    if (Wire.requestFrom(a, (uint8_t)1) == 1) {
      uint8_t who = Wire.read();
      mpuAddr = a;
      DBG("[MPU6050] endereço 0x%02X, WHO_AM_I=0x%02X\n", a, who);  // clones: 0x70/0x72/0x98
      break;
    }
  }
  if (!mpuAddr) return false;
  return mpuWrite(0x6B, 0x01)      // acorda, clock do giroscópio X (PLL)
         && mpuWrite(0x1A, 0x03)   // filtro passa-baixas digital ~44 Hz
         && mpuWrite(0x19, 0x09)   // 1 kHz / (1+9) = 100 Hz
         && mpuWrite(0x1C, 0x00);  // ±2 g → 16384 LSB/g
}

bool mpuReadAccel(float& ax, float& ay, float& az) {
  Wire.beginTransmission(mpuAddr);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(mpuAddr, (uint8_t)6) != 6) return false;
  int16_t x = (Wire.read() << 8) | Wire.read();
  int16_t y = (Wire.read() << 8) | Wire.read();
  int16_t z = (Wire.read() << 8) | Wire.read();
  ax = x / 16384.0f;
  ay = y / 16384.0f;
  az = z / 16384.0f;
  return true;
}

// Processamento: calibração → remove gravidade (passa-baixas) → RMS dinâmico
// por eixo → zona morta (ruído medido) → normalização 0–100 % → suavização.
struct VibState {
  bool calibrated = false;
  uint16_t n = 0;
  float sx = 0, sy = 0, sz = 0, sxx = 0;  // somatórios da calibração
  float gx = 0, gy = 0, gz = 0;            // gravidade estimada
  float ex = 0, ey = 0, ez = 0;            // energia (quadrado médio) por eixo
  float noise = 0;                         // RMS do sensor parado
};
VibState vib;

void setupMPU6050() {
#if ENABLE_MPU6050
  mpuOnline = mpuInit();
  if (mpuOnline) lcdShow("MPU6050", "CALIBRANDO...", P_NORMAL, 2000);
  else DBG("[MPU6050] não encontrado (a aplicação continua sem vibração física)\n");
#endif
}

uint8_t levelFor(float pct, uint8_t current) {
  // Histerese: só muda de faixa ao passar o limite ± VIB_HYST_PCT.
  float up1 = VIB_ATTENTION_PCT + VIB_HYST_PCT, up2 = VIB_HIGH_PCT + VIB_HYST_PCT;
  float dn1 = VIB_ATTENTION_PCT - VIB_HYST_PCT, dn2 = VIB_HIGH_PCT - VIB_HYST_PCT;
  if (current == 0) return pct > up2 ? 2 : pct > up1 ? 1 : 0;
  if (current == 1) return pct > up2 ? 2 : pct < dn1 ? 0 : 1;
  return pct < dn1 ? 0 : pct < dn2 ? 1 : 2;
}

const char* vibLevelName(uint8_t lv, bool ascii) {
  if (lv == 2) return "ALTA";
  if (lv == 1) return ascii ? "ATENCAO" : "ATENÇÃO";
  return "NORMAL";
}

void readMPU6050() {
#if ENABLE_MPU6050
  static uint32_t last = 0;
  uint32_t now = millis();
  if (!mpuOnline) {
    if (now - mpuRetryMs > 3000) {  // sensor reconectado?
      mpuRetryMs = now;
      if ((mpuOnline = mpuInit())) {
        vib = VibState();
        mpuFails = 0;
        lcdShow("MPU6050", "RECONECTADO", P_MEDIUM, 2000);
      }
    }
    return;
  }
  if (now - last < MPU_SAMPLE_MS) return;
  float dt = (now - last) / 1000.0f;
  last = now;

  float ax, ay, az;
  if (!mpuReadAccel(ax, ay, az)) {
    if (++mpuFails >= 5) {
      mpuOnline = false;
      mpuRetryMs = now;
      vibPct = vibX = vibY = vibZ = vibG = 0;
      vibLevel = 0;
      DBG("[MPU6050] desconectado\n");
      lcdShow("MPU6050", "DESCONECTADO", P_HIGH, 3000);
    }
    return;
  }
  mpuFails = 0;

  if (!vib.calibrated) {  // ~1,5 s com o conjunto parado
    vib.sx += ax;
    vib.sy += ay;
    vib.sz += az;
    vib.sxx += ax * ax + ay * ay + az * az;
    if (++vib.n >= MPU_CALIB_SAMPLES) {
      vib.gx = vib.sx / vib.n;
      vib.gy = vib.sy / vib.n;
      vib.gz = vib.sz / vib.n;
      float mean2 = vib.gx * vib.gx + vib.gy * vib.gy + vib.gz * vib.gz;
      vib.noise = sqrtf(fmaxf(0, vib.sxx / vib.n - mean2));
      vib.calibrated = true;
      DBG("[MPU6050] calibrado: g=(%.3f, %.3f, %.3f) ruído=%.4f g\n", vib.gx, vib.gy, vib.gz, vib.noise);
    }
    return;
  }

  // Gravidade acompanha inclinações lentas (τ ≈ 0,5 s); o resto é vibração.
  float kG = fminf(1, dt / 0.5f);
  vib.gx += (ax - vib.gx) * kG;
  vib.gy += (ay - vib.gy) * kG;
  vib.gz += (az - vib.gz) * kG;
  float dx = ax - vib.gx, dy = ay - vib.gy, dz = az - vib.gz;
  float kE = fminf(1, dt / 0.15f);  // janela de energia ≈ 150 ms
  vib.ex += (dx * dx - vib.ex) * kE;
  vib.ey += (dy * dy - vib.ey) * kE;
  vib.ez += (dz * dz - vib.ez) * kE;

  float dead = fmaxf(VIB_DEADZONE_G, vib.noise * 2.5f);
  auto clean = [&](float e) { return fmaxf(0, sqrtf(e) - dead); };
  float rx = clean(vib.ex), ry = clean(vib.ey), rz = clean(vib.ez);
  float mag = sqrtf(rx * rx + ry * ry + rz * rz);
  float pct = fminf(100, mag / VIB_FULL_SCALE_G * 100);

  // Suavização da saída (evita saltos visuais e mensagens à toa).
  const float kS = 0.25f;
  vibPct += (pct - vibPct) * kS;
  vibX += (rx - vibX) * kS;
  vibY += (ry - vibY) * kS;
  vibZ += (rz - vibZ) * kS;
  vibG += (mag - vibG) * kS;
  if (vibPct < 0.5f) vibPct = 0;

  uint8_t lv = levelFor(vibPct, vibLevel);
  if (lv != vibLevel) {
    vibLevel = lv;
    DBG("[MPU6050] vibração %s (%.0f%%)\n", vibLevelName(lv, true), vibPct);
    char l2[LCD_COLS + 1];
    snprintf(l2, sizeof(l2), "%s %d%%", vibLevelName(lv, true), (int)roundf(vibPct));
    lcdShow("VIBRACAO", l2, lv == 2 ? P_MEDIUM : P_NORMAL, 2500);
  }
#endif
}

// ============================================================================
//                       HC-SR04 (medição por interrupção)
// ============================================================================
volatile uint32_t echoStartUs = 0;
volatile uint32_t echoWidthUs = 0;
volatile bool echoDone = false;
volatile bool echoSeen = false;

void IRAM_ATTR onEchoEdge() {
  if (digitalRead(PIN_US_ECHO)) {
    echoStartUs = micros();
    echoSeen = true;
  } else if (echoStartUs) {
    echoWidthUs = micros() - echoStartUs;
    echoDone = true;
  }
}

void setupUltrasonic() {
#if ENABLE_HCSR04
  pinMode(PIN_US_TRIG, OUTPUT);
  digitalWrite(PIN_US_TRIG, LOW);
  pinMode(PIN_US_ECHO, INPUT);
  attachInterrupt(digitalPinToInterrupt(PIN_US_ECHO), onEchoEdge, CHANGE);
  usOnline = true;  // confirmado (ou não) pelas primeiras medições
#endif
}

float medianOf(float* v, uint8_t n) {
  float s[8];
  memcpy(s, v, n * sizeof(float));
  for (uint8_t i = 1; i < n; i++)
    for (uint8_t j = i; j > 0 && s[j] < s[j - 1]; j--) std::swap(s[j], s[j - 1]);
  return s[n / 2];
}

void readUltrasonic() {
#if ENABLE_HCSR04
  static uint32_t lastTrig = 0;
  static uint8_t noEcho = 0, nearCount = 0, farCount = 0;
  static float hist[5];
  static uint8_t histN = 0, histI = 0;
  static float shownCm = -1;
  static uint32_t shownMs = 0;
  uint32_t now = millis();
  if (now - lastTrig < US_PERIOD_MS) return;

  // 1) Resultado do disparo anterior.
  float cm = -1;
  if (lastTrig) {
    if (echoDone && echoWidthUs < US_TIMEOUT_US) {
      float d = echoWidthUs / 58.0f;
      if (d >= US_MIN_VALID_CM && d <= US_MAX_VALID_CM) cm = d;
    }
    // Nenhuma borda de subida em 2 s = sensor desconectado (sem objeto o
    // HC-SR04 ainda devolve um pulso longo).
    if (echoSeen) noEcho = 0;
    else if (++noEcho == 20) {
      usOnline = false;
      distanceCm = -1;
      DBG("[HC-SR04] sem resposta (desconectado?)\n");
      lcdShow("HC-SR04", "SEM RESPOSTA", P_HIGH, 3000);
    }
    if (echoSeen && !usOnline) {
      usOnline = true;
      lcdShow("HC-SR04", "RECONECTADO", P_MEDIUM, 2000);
    }
  }

  // 2) Mediana das últimas leituras válidas (descarta picos).
  if (cm > 0) {
    hist[histI] = cm;
    histI = (histI + 1) % 5;
    if (histN < 5) histN++;
    distanceCm = medianOf(hist, histN);
  } else if (usOnline) {
    histN = 0;
    distanceCm = -1;  // nada à frente (ou leitura inválida)
  }

  // 3) Histerese + leituras consecutivas: ≤3 cm explode, ≥5 cm monta.
  if (usOnline) {
    bool nearNow = distanceCm > 0 && distanceCm <= US_EXPLODE_CM;
    bool farNow = distanceCm < 0 || distanceCm >= US_ASSEMBLE_CM;
    nearCount = nearNow ? nearCount + 1 : 0;
    farCount = farNow ? farCount + 1 : 0;
    if (!handExploded && nearCount >= US_CONFIRM_READS) {
      handExploded = true;
      sendJson("{\"type\":\"event\",\"event\":\"explode\"}");
      DBG("[HC-SR04] %.1f cm → explode\n", distanceCm);
      lcdShow("VISTA EXPLODIDA", "ATIVADA", P_MEDIUM, 2500);
    } else if (handExploded && farCount >= US_CONFIRM_READS) {
      handExploded = false;  // só monta o que a mão explodiu
      sendJson("{\"type\":\"event\",\"event\":\"assemble\"}");
      DBG("[HC-SR04] afastou → monta\n");
      lcdShow("MONTAGEM", "RESTAURADA", P_MEDIUM, 2500);
    } else if (distanceCm > 0 && distanceCm < US_SHOW_CM && !handExploded &&
               (fabsf(distanceCm - shownCm) >= 0.3f || now - shownMs > 1000) && now - shownMs > 250) {
      shownCm = distanceCm;
      shownMs = now;
      char l2[LCD_COLS + 1];
      snprintf(l2, sizeof(l2), "%.1f cm", distanceCm);
      lcdShow("PROXIMIDADE", l2, P_MEDIUM, 1200);
      DBG("[HC-SR04] distância: %.1f cm\n", distanceCm);
    }
  }

  // 4) Novo disparo (pulso de 10 µs) — a medição chega pela interrupção.
  echoDone = false;
  echoSeen = false;
  echoStartUs = 0;
  digitalWrite(PIN_US_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_US_TRIG, LOW);
  lastTrig = now;
#endif
}

// ============================================================================
//                         COMUNICAÇÃO (WebSocket + MQTT)
// ============================================================================
#if MQTT_TLS
WiFiClientSecure mqttNet;
#else
WiFiClient mqttNet;
#endif
PubSubClient mqtt(mqttNet);
char topicUp[96], topicDown[96], topicOnline[96];

void sendJson(const char* json) {
  if (wsClients) ws.broadcastTXT(json);
#if MQTT_ENABLED
  if (mqtt.connected()) mqtt.publish(topicUp, json);
#endif
}

void sendHello(int8_t num) {
  char json[200];
  snprintf(json, sizeof(json),
           "{\"type\":\"hello\",\"device\":\"uPesy ESP32-C3 Mini\",\"fw\":\"2.0\",\"ip\":\"%s\","
           "\"sensors\":{\"encoder\":%s,\"mpu6050\":%s,\"hcsr04\":%s,\"lcd\":%s}}",
           localIp().c_str(), encoderOnline ? "true" : "false", mpuOnline ? "true" : "false",
           usOnline ? "true" : "false", lcdOnline ? "true" : "false");
  if (num >= 0) ws.sendTXT(num, json);
  else sendJson(json);  // MQTT (ou todos os clientes)
}

/** Telemetria: só quando algo muda de forma relevante (+ batimento a cada 1 s). */
void sendTelemetry() {
  static uint32_t lastSend = 0;
  static float sentPct = -1, sentDist = -2;
  static uint8_t sentLevel = 255;
  static bool sentSensors[4] = {false, false, false, false};
  uint32_t now = millis();
  if (!appConnected() || now - lastSend < VIB_SEND_MS) return;
  bool sensorsChanged = sentSensors[0] != encoderOnline || sentSensors[1] != mpuOnline ||
                        sentSensors[2] != usOnline || sentSensors[3] != lcdOnline;
  bool changed = fabsf(vibPct - sentPct) >= 1.0f || vibLevel != sentLevel ||
                 fabsf(distanceCm - sentDist) >= 0.2f || sensorsChanged;
  if (!changed && now - lastSend < 1000) return;
  lastSend = now;
  sentPct = vibPct;
  sentLevel = vibLevel;
  sentDist = distanceCm;
  sentSensors[0] = encoderOnline;
  sentSensors[1] = mpuOnline;
  sentSensors[2] = usOnline;
  sentSensors[3] = lcdOnline;

  char dist[16];
  if (distanceCm < 0 || !usOnline) strcpy(dist, "null");
  else snprintf(dist, sizeof(dist), "%.1f", distanceCm);
  char json[320];
  snprintf(json, sizeof(json),
           "{\"type\":\"telemetry\",\"rpm\":%d,\"distance\":%s,"
           "\"vibration\":{\"x\":%.3f,\"y\":%.3f,\"z\":%.3f,\"magnitude\":%.3f,\"percent\":%.1f,\"level\":\"%s\"},"
           "\"sensors\":{\"encoder\":%s,\"mpu6050\":%s,\"hcsr04\":%s,\"lcd\":%s}}",
           rpmRequested, dist, vibX, vibY, vibZ, vibG, vibPct, vibLevel == 2 ? "high" : vibLevel == 1 ? "attention" : "normal",
           encoderOnline ? "true" : "false", mpuOnline ? "true" : "false", usOnline ? "true" : "false",
           lcdOnline ? "true" : "false");
  sendJson(json);
}

/** Estado vindo da aplicação: {"type":"status",...} (ou "state", versão anterior). */
void applyAppStatus(JsonDocument& doc) {
  bool wasKnown = app.known;
  AppState prev = app;
  if (doc["rpm"].is<int>() || doc["rpm"].is<float>()) app.rpm = constrain((int)lroundf(doc["rpm"].as<float>()), RPM_MIN, RPM_MAX);
  if (doc["power"].is<bool>()) app.power = doc["power"].as<bool>();
  const char* machine = doc["machine"] | "";
  if (!strcmp(machine, "running")) app.power = true;
  else if (!strcmp(machine, "stopped")) app.power = false;
  if (doc["direction"].is<int>()) {
    int d = doc["direction"].as<int>();
    if (d == 1 || d == -1) app.direction = d;
  }
  if (doc["exploded"].is<bool>()) app.exploded = doc["exploded"].as<bool>();
  app.known = true;

  // A aplicação é a referência: o encoder passa a contar do valor confirmado,
  // exceto logo após um giro (evita "puxar de volta" durante a rotação).
  if (millis() - lastEncoderMs > ENCODER_HOLD_MS) rpmRequested = app.rpm;

  if (wasKnown && prev.power != app.power) lcdShow("MAQUINA", app.power ? "LIGADA" : "DESLIGADA", P_NORMAL, 2000);
  else if (wasKnown && prev.direction != app.direction)
    lcdShow("SENTIDO", app.direction > 0 ? "HORARIO" : "ANTI-HORARIO", P_NORMAL, 2000);
  else if (wasKnown && prev.rpm != app.rpm && millis() - lastEncoderMs > ENCODER_HOLD_MS) {
    char l2[LCD_COLS + 1];
    snprintf(l2, sizeof(l2), "%d RPM", app.rpm);
    lcdShow("RPM", l2, P_NORMAL, 2000);
  }
  // Mudança vinda da própria aplicação (botão/slider): mantém a "mão" coerente.
  if (!app.exploded) handExploded = false;
}

/** Mensagem da aplicação (WebSocket: num ≥ 0 · MQTT: num = −1). */
void processAppMessage(const uint8_t* payload, size_t length, int8_t num) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, length)) return;  // JSON inválido: ignora
  const char* t = doc["type"] | "";
  if (!strcmp(t, "hello")) sendHello(num);
  else if (!strcmp(t, "status") || !strcmp(t, "state")) applyAppStatus(doc);
}

void handleWebSocketEvent(uint8_t num, WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      wsClients++;
      DBG("[ESP32] aplicação conectada (#%u, %s)\n", num, ws.remoteIP(num).toString().c_str());
      lcdShow("DIGITAL TWIN", "CONECTADO", P_MEDIUM, 2500);
      sendHello(num);
      break;

    case WStype_DISCONNECTED:
      if (wsClients) wsClients--;
      DBG("[ESP32] aplicação desconectada (#%u)\n", num);
      if (!appConnected()) {
        app.known = false;
        lcdShow("APLICACAO", "DESCONECTADA", P_HIGH, 3000);
      }
      break;

    case WStype_TEXT:
      processAppMessage(payload, length, num);
      break;
    default:
      break;
  }
}

// ---- MQTT -------------------------------------------------------------------
uint32_t mqttRetryAt = 0;
uint32_t lastAppMsgMs = 0;

void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  if (strcmp(topic, topicDown) != 0) return;
  lastAppMsgMs = millis();
  if (!mqttAppAlive) {
    mqttAppAlive = true;
    DBG("[MQTT] aplicação ativa\n");
    lcdShow("DIGITAL TWIN", "CONECTADO MQTT", P_MEDIUM, 2500);
  }
  processAppMessage(payload, length, -1);
}

void setupMQTT() {
#if MQTT_ENABLED
  snprintf(topicUp, sizeof(topicUp), "%s/up", MQTT_TOPIC);
  snprintf(topicDown, sizeof(topicDown), "%s/down", MQTT_TOPIC);
  snprintf(topicOnline, sizeof(topicOnline), "%s/online", MQTT_TOPIC);
#if MQTT_TLS
  mqttNet.setInsecure();          // TLS sem validar o certificado do broker
  mqttNet.setHandshakeTimeout(5); // limita o tempo bloqueado se o broker não responder
#endif
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqttMessage);
  mqtt.setBufferSize(512);  // telemetria ≈ 300 bytes
  mqtt.setKeepAlive(15);
  mqtt.setSocketTimeout(5);
#endif
}

/**
 * Conecta ao broker com last will ("<tópico>/online" = "0", retido): se a
 * placa perder energia ou rede, o broker avisa a aplicação. Tentativas
 * espaçadas (cada uma pode bloquear alguns segundos; o encoder segue contando
 * pela interrupção).
 */
void handleMQTT() {
#if MQTT_ENABLED
  uint32_t now = millis();
  if (mqttAppAlive && now - lastAppMsgMs > MQTT_APP_TIMEOUT_MS) {
    mqttAppAlive = false;
    DBG("[MQTT] aplicação sem resposta\n");
    if (!appConnected()) {
      app.known = false;
      lcdShow("APLICACAO", "DESCONECTADA", P_HIGH, 3000);
    }
  }
  if (!wifiUp || apMode) return;  // no modo AP não há internet
  if (mqtt.connected()) {
    mqtt.loop();
    return;
  }
  if ((int32_t)(now - mqttRetryAt) < 0) return;
  mqttRetryAt = now + MQTT_RETRY_MS;
  char clientId[40];
  snprintf(clientId, sizeof(clientId), "furadeira-%06llx-%04lx", ESP.getEfuseMac() & 0xFFFFFF, (unsigned long)(esp_random() & 0xFFFF));
  DBG("[MQTT] conectando a %s:%u…\n", MQTT_HOST, MQTT_PORT);
  const char* user = strlen(MQTT_USER) ? MQTT_USER : nullptr;
  const char* pass = strlen(MQTT_PASS) ? MQTT_PASS : nullptr;
  if (mqtt.connect(clientId, user, pass, topicOnline, 1, true, "0")) {
    mqtt.publish(topicOnline, "1", true);
    mqtt.subscribe(topicDown);
    DBG("[MQTT] conectado · tópico %s\n", MQTT_TOPIC);
    lcdShow("MQTT", "BROKER OK", P_NORMAL, 2000);
    sendHello(-1);
  } else {
    DBG("[MQTT] falhou (rc=%d), nova tentativa em %lus\n", mqtt.state(), (unsigned long)(MQTT_RETRY_MS / 1000));
    lcdShow("MQTT", "SEM BROKER", P_HIGH, 2500);
  }
#endif
}

void setupWebSocket() {
  ws.begin();
  ws.onEvent(handleWebSocketEvent);
  ws.enableHeartbeat(15000, 3000, 2);  // derruba clientes "fantasmas"
}

// ============================================================================
//                               SETUP / LOOP
// ============================================================================
void scanI2C() {
#if IOT_DEBUG
  Serial.print("[I2C] dispositivos:");
  uint8_t n = 0;
  for (uint8_t a = 1; a < 127; a++)
    if (i2cPresent(a)) {
      Serial.printf(" 0x%02X", a);
      n++;
    }
  Serial.println(n ? "" : " nenhum (verifique SDA/SCL e alimentação)");
#endif
}

void setup() {
  Serial.begin(115200);
  delay(300);  // USB CDC do C3: dá tempo do Monitor Serial abrir
  DBG("\n=== DIGITAL TWIN · furadeira · %s ===\n", ESP.getChipModel());

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  Wire.setClock(100000);  // 100 kHz: limite do PCF8574 do LCD
  Wire.setTimeOut(20);    // I2C travado não trava o firmware
  scanI2C();

  setupLCD();
  lcdShow("DIGITAL TWIN", "INICIANDO...", P_NORMAL, 1200);
  updateLCD();
  setupEncoder();
  setupMPU6050();
  setupUltrasonic();
  setupWiFi();
  setupWebSocket();
  setupMQTT();
}

void loop() {
  handleWiFi();
  ws.loop();
  handleMQTT();
  readEncoder();
  readButton();
  readMPU6050();
  readUltrasonic();
  sendTelemetry();
  updateLCD();
}

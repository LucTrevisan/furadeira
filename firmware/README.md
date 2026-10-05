# Digital Twin IoT — uPesy ESP32-C3 Mini + KY-040 + MPU6050 + HC-SR04 + LCD

Comunicação por **MQTT** (padrão: rede IoT, internet e GitHub Pages) ou
**WebSocket local** (ponte do `npm run dev`) — mesmas mensagens nas duas vias.

Camada **aditiva** de interação física. A aplicação Babylon.js continua
funcionando exatamente igual sem o hardware (MODO NORMAL). Com o ESP32
conectado (MODO IoT), os sensores alimentam as funções que já existem:

| Dispositivo | Faz | Na aplicação usa |
|---|---|---|
| KY-040 (girar) | RPM 0–3000, 50 por clique | `DrillController.applyRemote({rpm})`: o mesmo setpoint do slider |
| KY-040 (clique / clique longo) | liga-desliga / inverte | `applyRemote({power})` / `applyRemote({direction})` |
| MPU6050 | vibração real | microvibração no `VibrationEffect` existente + indicador NORMAL/ATENÇÃO/ALTA |
| HC-SR04 | mão ≤ 3 cm explode, ≥ 5 cm monta | a vista explodida existente (`explodeTo`, mesma de botão/tecla/VR) |
| LCD 16x2 I2C | feedback | recebe `{"type":"status"}` da aplicação (estado real) |

A **aplicação é a fonte do estado**: o ESP32 envia comandos e telemetria, e a
aplicação confirma o estado de volta. Por isso o LCD, o slider, o painel e o
modelo nunca divergem.

---

## 1. Placa: uPesy ESP32-C3 Mini (verificado na documentação da uPesy)

* GPIOs expostos: **1–9** (e 20/21, UART). Lógica de **3,3 V**: as entradas **não toleram 5 V**.
* **GPIO 2, 8, 9** são de *strapping* (o 9 é o botão BOOT): no boot devem ficar em nível alto.
* GPIO 18/19 = USB (não usar). GPIO 0 mede a alimentação (não exposto). **Não há LED** na placa.
* Arduino IDE: placa **ESP32C3 Dev Module** (ou "uPesy ESP32C3 Mini"), **USB CDC On Boot: Enabled**.

## 2. Ligação

| Sinal | GPIO | Observação |
|---|---|---|
| I2C SDA (MPU6050 + LCD) | **1** | pinagem confirmada nos testes (MPU6050 em 0x68) |
| I2C SCL (MPU6050 + LCD) | **0** | |
| HC-SR04 ECHO | **3** | **obrigatório divisor**: ECHO → 1 kΩ → GPIO 3, e GPIO 3 → 2 kΩ → GND |
| HC-SR04 TRIG | **4** | 3,3 V é aceito como nível alto |
| KY-040 CLK | **5** | módulo alimentado em **3V3** |
| KY-040 DT | **6** | |
| KY-040 SW | **7** | pull-up interno |
| (reservado) | **10** | servo, uso futuro |

GPIO 2, 8 e 9 (strapping) ficaram livres, o que é o mais seguro para o boot.

**Wi-Fi:** copie `furadeira_esp32/secrets.example.h` para `secrets.h` (mesma
pasta) e preencha nome e senha. O `secrets.h` é ignorado pelo git: a senha
não vai para o GitHub.

Alimentação: KY-040 e MPU6050 (GY-521) em **3V3**; HC-SR04 e LCD em **5V**
(pino 5V/VBUS — presente com o USB conectado). Todos os GND juntos.

> ⚠ **HC-SR04 comum (5 V):** o ECHO sai em 5 V. Ligado direto, pode danificar o
> GPIO. Use o divisor 1 kΩ/2 kΩ (5 V → 3,33 V).
>
> ⚠ **LCD I2C em 5 V:** a plaquinha PCF8574 tem resistores de pull-up para o
> VCC dela (5 V), o que leva SDA/SCL a 5 V. Use **conversor de nível I2C**
> (módulo BSS138 de 4 canais: lado LV no ESP32/MPU, lado HV no LCD) **ou**
> retire os dois resistores de pull-up da plaquinha (o GY-521 já tem pull-ups
> para 3,3 V; o PCF8574 normalmente reconhece 3,3 V como nível alto).

## 3. Bibliotecas e gravação

1. Gerenciador de Bibliotecas: **WebSockets** (Markus Sattler, ≥ 2.4),
   **ArduinoJson** (Benoit Blanchon, 7.x) e **PubSubClient** (Nick O'Leary,
   2.8 — MQTT). LCD e MPU6050 usam drivers próprios no sketch.
2. Rode primeiro **`firmware/i2c_scanner`** e confira os endereços reais
   (MPU6050: 0x68/0x69; LCD: 0x20–0x27 ou 0x38–0x3F). O firmware também
   detecta os endereços sozinho, mas o scanner confirma a fiação.
3. Preencha o Wi-Fi em `furadeira_esp32/secrets.h` (rede **2,4 GHz**) e grave. Monitor Serial a 115200: anote o IP (o LCD também mostra o IP).

Todos os parâmetros (pinos, RPM, passos, limiares de vibração e distância,
tempos do LCD, broker, `IOT_DEBUG`) ficam no **início do sketch**.

## 3.1 Duas vias de comunicação (o firmware usa as duas ao mesmo tempo)

### MQTT — padrão (rede IoT da escola, internet, GitHub Pages)

```
ESP32 ──► broker MQTT ◄── página (no PC, no Quest ou no GitHub Pages)
```
A placa e a página não precisam se "enxergar" na rede: as duas só falam com
o broker. Por isso funciona na rede IoT da escola **e no link do GitHub
Pages**, sem `npm run dev`.

* Broker padrão: **HiveMQ público** — placa em `broker.hivemq.com:8883` (TLS),
  página em `wss://broker.hivemq.com:8884/mqtt`.
* Tópico exclusivo desta furadeira: **`senai-furadeira/d3f5f010`**
  (`MQTT_TOPIC` no sketch e campo *Tópico* na página — **os dois iguais**).
  * `<tópico>/up`     placa → página (hello, eventos, telemetria)
  * `<tópico>/down`   página → placa (hello, status a cada mudança e a cada 5 s)
  * `<tópico>/online` `"1"`/`"0"` retido. Se a placa perder energia ou rede, o
    broker publica `"0"` sozinho (*last will*) e a página volta ao MODO NORMAL.
* Na página: **IoT / Hardware → Via: MQTT** (já é o padrão) → conecta sozinha.
  Selo "aguardando ESP32" = broker ok, placa ainda não respondeu.
* Mais de uma página pode abrir ao mesmo tempo (PC + Quest): todas recebem.

> **Segurança.** No broker público, qualquer pessoa que souber o tópico pode
> ler e enviar comandos. Para uso contínuo use um broker com usuário/senha
> (HiveMQ Cloud gratuito, ou um Mosquitto da escola): troque `MQTT_HOST`,
> defina `MQTT_USER`/`MQTT_PASS` no `secrets.h` e informe usuário/senha nos
> campos da página (a senha fica só na sessão do navegador). O broker precisa
> oferecer **MQTT sobre WebSocket seguro (wss)** para a página.

### WebSocket local — alternativa (sem internet)

```
ESP32:81 ◄── servidor "npm run dev" (/esp32) ◄── página
```
1. Na raiz do projeto, `.env.local` com `ESP32_HOST=<ip>` (ou deixe o padrão
   `furadeira.local`) e rode `npm run dev` (ou `npm run dev:https` para o Quest).
2. Na página: **IoT / Hardware → Via: WebSocket local** → Conectar.
Útil quando não há internet (por exemplo, com a placa no modo AP
`Furadeira-ESP32`). Exige que PC e placa se enxerguem na rede.

## 4. Protocolo (JSON — idêntico nas duas vias)

ESP32 → aplicação:
```json
{"type":"hello","device":"uPesy ESP32-C3 Mini","fw":"2.0","sensors":{"encoder":true,"mpu6050":true,"hcsr04":true,"lcd":true}}
{"type":"event","event":"encoder","rpm":1350}
{"type":"event","event":"power","power":true}
{"type":"event","event":"direction","direction":-1}
{"type":"event","event":"explode"}      {"type":"event","event":"assemble"}
{"type":"telemetry","rpm":1350,"distance":8.4,
 "vibration":{"x":0.02,"y":0.08,"z":0.03,"magnitude":0.09,"percent":26,"level":"normal"},
 "sensors":{"encoder":true,"mpu6050":true,"hcsr04":true,"lcd":true}}
```
Aplicação → ESP32:
```json
{"type":"hello"}
{"type":"status","machine":"running","rpm":1500,"power":true,"direction":1,"exploded":false}
```
A aplicação valida tudo (JSON, tipo conhecido, RPM 0–3000, números finitos),
nunca executa conteúdo recebido e ignora mensagens inválidas. O formato
antigo (`{"rpm","power","direction"}`) continua aceito.

Taxas: encoder só quando muda (agrupado a cada 40 ms); MPU6050 amostrado a
100 Hz, telemetria até 20 Hz **apenas se mudar** (+ 1 batimento por segundo);
HC-SR04 a 10 Hz; LCD só reescreve os caracteres que mudaram.

## 5. Processamento dos sensores

**MPU6050:** calibração ao ligar (~1,5 s **parado**: mede gravidade e ruído) →
remoção da gravidade por passa-baixas (acompanha inclinações lentas) → energia
RMS por eixo (janela ~150 ms) → **zona morta** (máx. entre 0,015 g e 2,5× o
ruído medido) → normalização (0,35 g = 100 %) → suavização → faixas com
histerese: NORMAL ≤ 30 % < ATENÇÃO ≤ 70 % < ALTA. Valores de demonstração:
calibre `VIB_FULL_SCALE_G` e os limites para o seu conjunto.

**HC-SR04:** medição por interrupção (não bloqueia o loop), mediana das 5
últimas leituras válidas e **3 leituras consecutivas** para confirmar.
Histerese: explode em ≤ 3 cm e monta em ≥ 5 cm (entre 3 e 5, mantém). Só monta
o que a mão explodiu: não desfaz uma vista explodida feita pelo botão.
> O HC-SR04 tem alcance mínimo de ~2 cm; 3 cm fica perto do limite. Se a
> detecção ficar instável, use `US_EXPLODE_CM = 5` e `US_ASSEMBLE_CM = 8`.

**LCD — prioridades:** ALTA (erros, sensor ou aplicação desconectados) >
MÉDIA (vista explodida, vibração alta, proximidade) > NORMAL (RPM, máquina) >
BAIXA (telas de status em rodízio a cada 3 s: DIGITAL TWIN ONLINE · RPM ·
VIBRAÇÃO · DISTÂNCIA). Uma mensagem no ar só é substituída por outra de
prioridade igual ou maior. Sem a aplicação, o LCD alterna AGUARDANDO
APLICACAO com o IP da placa.

## 6. Testes individuais (um sensor por vez)

No topo do sketch, deixe `IOT_DEBUG 1` e habilite **um** periférico por vez
(`ENABLE_ENCODER`, `ENABLE_MPU6050`, `ENABLE_HCSR04`, `ENABLE_LCD`).

| Teste | Como | Esperado no Monitor Serial / LCD |
|---|---|---|
| 0. I2C | `i2c_scanner` | endereços do MPU6050 e do LCD listados |
| 1. Wi-Fi + WebSocket | firmware sem periféricos; abrir a página | `[WIFI] conectado. IP …`, `[ESP32] aplicação conectada`; na página, selo **MODO IoT** e "ESP32 online" |
| 2. KY-040 | girar / clicar / segurar | `[KY040] RPM: 1250`; slider e painel acompanham; clique liga, clique longo inverte |
| 3. MPU6050 | ligar parado, depois bater de leve na mesa | `[MPU6050] calibrado…`; `vibração ATENCAO/ALTA`; modelo 3D treme levemente; card mostra a faixa |
| 4. HC-SR04 | aproximar a mão até 2 cm, afastar | `[HC-SR04] distância: 4.2 cm` → `explode` → `monta` |
| 5. LCD | ligar | DIGITAL TWIN INICIANDO → CONECTANDO WIFI → WIFI CONECTADO → AGUARDANDO APLICACAO / IP |

Sem hardware: `npm run esp32:sim` (WebSocket) ou `npm run esp32:sim:mqtt` (MQTT, mesmo tópico do firmware) simula o firmware 2.0 (→/← encoder, Espaço
clique, L clique longo, **V** vibração, **P** mão). Com
`ESP32_HOST=127.0.0.1` e `ESP32_PORT=81` no `.env.local`.

## 7. Teste integrado (roteiro da demonstração)

1. Ligue o ESP32 → LCD: DIGITAL TWIN INICIANDO… → WIFI CONECTADO.
2. Abra a aplicação → LCD: **DIGITAL TWIN CONECTADO**; página: **MODO IoT**.
3. Gire o KY-040 → LCD **RPM 1500**; slider e painel em 1500; clique → liga.
4. Bata/vibre o conjunto → página **VIBRAÇÃO ATENÇÃO** (ou ALTA) e microvibração do modelo; LCD **VIBRACAO ATENCAO**.
5. Aproxime a mão: LCD **PROXIMIDADE 4.2 cm** → ≤ 3 cm: **VISTA EXPLODIDA ATIVADA** e o modelo explode.
6. Afaste ≥ 5 cm → **MONTAGEM RESTAURADA** e o modelo remonta.
7. Desligue o ESP32 → página volta ao MODO NORMAL e tudo continua funcionando; religue → reconecta sozinho (1 s, 2 s, 5 s, depois a cada 10 s).

## 8. Checklist WebXR

- [ ] **Com MQTT (padrão):** no Meta Quest, abra o link do GitHub Pages (já é HTTPS) — não precisa do PC.
      Com WebSocket local: `npm run dev:https` no PC e `.env.local` com o IP do ESP32.
- [ ] Selo **MODO IoT** aparece **antes** de entrar no VR (IoT / Hardware mostra "conectado").
- [ ] Dentro do VR: girar o KY-040 muda o RPM no painel 3D; vibração aparece no modelo; mão no HC-SR04 explode/monta.
- [ ] Desconectar o ESP32 dentro do VR não interrompe a sessão.

## 9. Falhas previstas (o hardware nunca é obrigatório)

| Falha | Comportamento |
|---|---|
| ESP32 / Wi-Fi | aplicação em MODO NORMAL, reconexão automática em segundo plano (MQTT: o *last will* avisa a página na hora) |
| Broker MQTT / internet | placa e página tentam reconectar; o WebSocket local continua disponível como alternativa |
| KY-040 | slider e botões continuam |
| MPU6050 | LCD "MPU6050 DESCONECTADO"; vibração física zera; tenta reconectar a cada 3 s |
| HC-SR04 | LCD "HC-SR04 SEM RESPOSTA" após 2 s sem eco; botões da vista explodida continuam |
| LCD | firmware segue sem ele e tenta reencontrá-lo a cada 5 s |
| Wi-Fi da rede | após 15 s cria a rede **Furadeira-ESP32** (senha `furadeira123`, IP 192.168.4.1) |

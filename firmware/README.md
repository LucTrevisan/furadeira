# ESP32 + encoder KY-040 → controle da furadeira via WebSocket

O ESP32 lê o encoder e envia `{"rpm":…,"power":…,"direction":…}` para a
página por WebSocket. A animação, os painéis (HTML e VR) e a rampa suave de
velocidade são os mesmos de antes: o ESP32 só chama as mesmas funções.

| Ação no encoder | Efeito |
|---|---|
| Girar para a direita / esquerda | +/− RPM (50 por clique; girando rápido, 200) |
| Clique curto no eixo | LIGA / DESLIGA |
| Clique longo (0,7 s) | INVERTE o sentido |
| LED azul da placa | Aceso = furadeira ligada |

Mudanças feitas na página (slider, botões, Quest) também voltam para o ESP32,
então o encoder continua a partir do valor atual.

## 1. Ligação

**ESP32 D1 Mini (WROOM-32)**

| KY-040 | ESP32 D1 Mini |
|---|---|
| CLK | GPIO **25** |
| DT  | GPIO **26** |
| SW  | GPIO **27** |
| +   | **3V3** (não use 5V) |
| GND | GND |

**ESP32-C3 Super Mini** (escolhido automaticamente na compilação):
CLK = GPIO 5, DT = GPIO 6, SW = GPIO 7, + = 3V3, GND = GND.

> Alimente o KY-040 com **3,3 V**: os resistores de pull-up do módulo levam
> CLK/DT à tensão do "+", e 5 V nos pinos do ESP32 pode danificá-lo.

Os pinos podem ser trocados no início do sketch (`PIN_CLK`, `PIN_DT`, `PIN_SW`).

## 2. Arduino IDE

1. **Placas**: Gerenciador de Placas → instale **esp32** (Espressif).
   Selecione *WEMOS D1 MINI ESP32* (ou *ESP32 Dev Module*); para o C3,
   *ESP32C3 Dev Module* com *USB CDC On Boot: Enabled*.
2. **Bibliotecas**: Gerenciador de Bibliotecas → instale
   * **WebSockets** de *Markus Sattler* (Links2004)
   * **ArduinoJson** de *Benoit Blanchon* (versão 7)
3. Abra `firmware/furadeira_esp32/furadeira_esp32.ino` e preencha:
   ```cpp
   const char* WIFI_SSID = "NOME_DA_SUA_REDE";
   const char* WIFI_PASS = "SENHA_DA_SUA_REDE";
   ```
   Use a **mesma rede** do PC (e do Meta Quest). Redes de 5 GHz não funcionam
   no ESP32; use 2,4 GHz.
4. Envie para a placa e abra o **Monitor Serial a 115200**. Anote o IP:
   ```
   [wifi] conectado. IP: 192.168.15.50
   [ws] servidor em ws://192.168.15.50:81
   ```
   Se a rede não conectar em 15 s, o ESP32 cria a rede **Furadeira-ESP32**
   (senha `furadeira123`, IP `192.168.4.1`).

Girando o encoder, o Monitor Serial mostra cada mudança (`[local] RPM …`).

## 3. Ligar a página ao ESP32

Na raiz do projeto, crie **`.env.local`** (copie de `.env.example`) com o IP:

```
ESP32_HOST=192.168.15.50
ESP32_PORT=81
```

Reinicie o servidor (`npm run dev` ou `npm run dev:https`). No painel, abra
**Integração ESP32**, deixe a URL sugerida (`ws://…/esp32`) e clique em
**CONECTAR**. O selo fica verde ("conectado"), e o navegador lembra a escolha
nas próximas vezes (ou abra a página com `?ws=auto`).

### Por que `/esp32` e não o IP direto?

A página do VR precisa de **HTTPS**, e uma página HTTPS é proibida de abrir
`ws://` (conteúdo misto). O servidor do Vite resolve isso: a página conecta em
`wss://<pc>:5173/esp32` (seguro, mesma origem) e o Vite repassa para
`ws://ESP32_HOST:81`. Assim o **Meta Quest funciona sem certificado no ESP32**.

* Página em `http://localhost` (desktop): também dá para usar o IP direto,
  `ws://192.168.15.50:81`.
* Página publicada num site estático (GitHub Pages etc.): não há ponte; seria
  preciso `wss://` no ESP32 ou um pequeno servidor-ponte na rede local.

## 4. Testar sem o ESP32

```bash
npm run esp32:sim
```

Cria um ESP32 falso em `ws://localhost:81` com o mesmo protocolo. No
terminal: **→/+** e **←/−** giram o "encoder", **Espaço** = clique curto,
**L** = clique longo. Use `ESP32_HOST=127.0.0.1` no `.env.local`.
(`npm run esp32:sim -- --demo` muda o estado sozinho a cada 1,5 s.)

## 5. Problemas comuns

| Sintoma | Causa / solução |
|---|---|
| Selo fica em "conectando…" | IP errado no `.env.local`, ESP32 em outra rede, ou servidor não reiniciado após criar o `.env.local`. |
| Precisa de 2 cliques para o RPM mudar | Seu KY-040 gera 2 transições por clique: use `STEPS_PER_DETENT = 2`. |
| Um clique muda o RPM 2 vezes | Volte para `STEPS_PER_DETENT = 4`. |
| Girar para a direita diminui | `INVERT_ENCODER = true` ou troque os fios CLK/DT. |
| Botão não responde | Confirme o SW no GPIO 27 (o sketch ativa o pull-up interno). |
| Não aparece IP no Serial | Rede de 5 GHz ou senha errada → o ESP32 cai no modo ponto de acesso. |

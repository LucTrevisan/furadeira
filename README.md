# Furadeira Manual Interativa — WebXR (Babylon.js + TypeScript + Vite)

Visualização e simulação de uma furadeira manual 3D no navegador (desktop e
celular) e em realidade virtual no **Meta Quest**, com o mandril girando de
0 a 3000 RPM, inversão de sentido, painel de controle industrial e ponte
WebSocket preparada para um **ESP32**.

---

## 1. Análise do modelo GLB (feita antes de implementar a rotação)

Arquivo: `public/models/furadeira.glb` (9,4 MB, exportado pelo SolidWorks,
unidades em metros, 70 nós, 51 malhas, 29 materiais).

Hierarquia relevante (nomes **exatos** do arquivo):

```
MONTAGEM MAQUINA DE FURAR MANUAL
├─ MONTAGEM MANDRIL                      ← mandril: submontagem SEPARADA ✔
│  ├─ CORPO ROSCADO-1                    ← corpo; eixo de revolução = Y local
│  ├─ CAPA DO MANDRIL-1
│  └─ SUBMONT CASTANHAS                  ← 3 castanhas, cone de ajuste, 3 molas
├─ EIXO DO MANDRIL-1                     ← eixo-árvore (coaxial ao mandril)
├─ PINHAOZ 15 a-1                        ← pinhão Z15 no eixo-árvore
├─ BUCHA DE MANDRIL-3                    ← mancal (fixo)
├─ COROA Z 30-1 + ENGRENAGEM MAIOR M1_Z15 a-1 + EIXO DAS ENGRENAGENS-5
├─ ENGREN MENOR MOD 1  Z 43 a-1 + ENGRENAGEM MENOR M1_Z15 a-1 + EIXO DAS ENGRENAGENS 2-1
├─ ENGREN MAIOR MOD 1  Z 43 a-1 + EIXO DAS ENGRENAGENS 3-1
├─ SUBMONT MANIVELA                      ← manivela (gira no eixo da Z43 maior)
├─ CORPO DE ALUMINIO-1, TAMPA-1, TAMPA-2, SUB MONT CABO SUST, SUBMONT  DO ENCOSTO…
```

Conclusões:

* **O mandril é um objeto independente** — não é preciso editar o CAD.
  O eixo de rotação foi verificado numericamente: `CORPO ROSCADO-1`,
  `CONE DE AJUSTE-1`, `EIXO DO MANDRIL-1` e `PINHAOZ 15 a-1` são coaxiais
  (direção ≈ (1; −0,012; −0,025) no espaço do GLB).
* **O modelo não possui broca.** Como alternativa, a aplicação cria uma
  **broca procedural** (cilindro com faixas helicoidais) presa às castanhas,
  que gira com o mandril. Ela não altera o GLB e pode ser desligada
  (`BIT.enabled = false` em `src/config.ts`).
* O trem de engrenagens também foi identificado (distâncias entre eixos de
  29 mm = par Z43/Z15, módulo 1). Com `GEAR_TRAIN.enabled = true`, coroa,
  engrenagens e **manivela** giram com as relações reais
  (manivela ≈ 0,061 × velocidade do mandril).
* O GLB traz 11 câmeras (vistas do SolidWorks) e 2 luzes com escala inválida;
  elas são removidas após o carregamento (`MODEL.removeEmbeddedCamerasAndLights`).
  A geometria não é alterada.

> **Se o mandril de outro modelo vier fundido ao corpo** (um único mesh), não
> é possível girá-lo isoladamente sem cortar a malha. A solução correta é
> separar o mandril como peça/corpo próprio no CAD (SolidWorks: peça
> independente na montagem; Blender: *Separate → By Selection*), nomeá-lo
> claramente e reexportar o GLB. Paliativo: ocultar a região e sobrepor um
> mandril procedural.

---

## 2. Requisitos

* Node.js 20.19+ ou 22.12+ (exigência do Vite 8) e npm.
* Navegador com WebGL2 (Chrome, Edge, Firefox, Safari recentes).
* Para VR: Meta Quest 2/3/3S/Pro com o **Meta Quest Browser** e acesso via **HTTPS**.

## 3. Instalação

```bash
npm install
```

## 4. Executar localmente (desktop)

```bash
npm run dev
```

Abra `http://localhost:5173`. Mouse: arrastar = orbitar, roda = zoom,
botão direito = deslocar. Toque: arrastar / pinça. Teclado: **Espaço**
liga/desliga, **R** inverte, **← →** ajustam o RPM.

Build de produção:

```bash
npm run build      # gera dist/
npm run preview    # serve dist/ em http://localhost:4173
```

## 5. Disponibilizar via HTTPS (obrigatório para WebXR)

O WebXR só funciona em **contexto seguro**. Opções, da mais rápida à definitiva:

| Opção | Como |
|---|---|
| **A. HTTPS na rede local** | `npm run dev:https` → abra `https://<IP-do-PC>:5173` no Quest e aceite o aviso do certificado autoassinado ("Avançado → Continuar"). PC e Quest na mesma rede Wi-Fi. |
| **B. Cabo USB (adb)** | Com o modo desenvolvedor ativo: `adb reverse tcp:5173 tcp:5173`, depois `npm run dev` e abra `http://localhost:5173` no Quest (localhost conta como seguro). |
| **C. Túnel público** | `npm run dev` e, em outro terminal, `npx cloudflared tunnel --url http://localhost:5173` (ou `ngrok http 5173`). Use a URL `https://…` gerada. |
| **D. Hospedagem** | `npm run build` e publique a pasta `dist/` no GitHub Pages, Netlify, Vercel ou Cloudflare Pages (todos com HTTPS). O `vite.config.ts` usa `base: "./"`, então funciona em subpastas. |

## 6. Testar no Meta Quest

1. Disponibilize a página por HTTPS (seção 5).
2. No Quest, abra o **Meta Quest Browser** e acesse a URL (dica: envie o link
   para o headset pelo app Meta Horizon no celular, ou use um app de QR Code
   da loja do Quest).
3. Aguarde o modelo carregar e toque em **ENTRAR EM VR**.
4. Você começará em pé, diante da bancada; a furadeira fica à frente, em
   escala real (~40 cm), e o painel 3D à direita.

### Controles no VR (mapeamento em `XR_BINDINGS`, `src/config.ts`)

| Controle | Ação |
|---|---|
| Gatilho direito (segurar) | Liga enquanto pressionado; soltar desliga |
| Grip **com a mão na manivela** (ou numa engrenagem/mandril) | Agarra a peça: gire a mão em círculo para girar a furadeira à mão |
| Grip direito / grip esquerdo longe das peças (segurar) | Aumenta / diminui o RPM |
| Botão **A** | Inverte o sentido |
| Botão **B** | Liga/desliga (modo travado) |
| Botão **X** | Aproximar/afastar: traz o mandril para ~32 cm dos olhos |
| Botão **Y** | Reset |
| Thumbstick esquerdo (←/→) | Gira a furadeira para ver de outros ângulos |
| Thumbstick direito (↑) | Teletransporte pelo piso |
| Raio + gatilho no painel 3D | LIGAR, DESLIGAR, ±RPM, slider, INVERTER, RESET, APROXIMAR |

Apontar o gatilho para o painel **não** liga a furadeira (o clique é do painel).
Para trocar qualquer comando, edite apenas a lista `XR_BINDINGS`.

> O painel HTML não aparece dentro do headset (limitação do WebXR); por isso
> existe o painel 3D, que chama exatamente as mesmas funções.

---

## 7. Configuração do mandril: eixo e ponto de rotação

Tudo fica em **`src/config.ts`**:

```ts
export const CHUCK = {
  id: "mandril",
  nodes: ["MONTAGEM MANDRIL", "EIXO DO MANDRIL-1", "PINHAOZ 15 a-1"], // giram juntos
  axisNode: "CORPO ROSCADO-1",  // nó que define o eixo
  axisLocal: [0, 1, 0],         // eixo nas coordenadas LOCAIS desse nó
  // pivotLocal: [0, 0, 0],     // ponto de rotação (local); omitido = centro da peça
  ratio: 1,
};
```

* **`nodes`**: nomes exatos dos nós que giram (os filhos acompanham).
* **`axisNode` + `axisLocal`**: o eixo é o vetor `axisLocal` no espaço do
  `axisNode`. Para peças de revolução, é o eixo cuja caixa envolvente é
  simétrica nos outros dois (aqui, Y do `CORPO ROSCADO-1`).
* **`pivotLocal`**: ponto por onde o eixo passa. Se omitido, usa o centro
  da caixa envolvente do `axisNode`, correto para peças de revolução.
* **Sentido horário**: `DRILL.clockwiseViewedFrom = "behind"` → horário visto
  por trás da ferramenta (posição do operador, olhando para a broca), a
  convenção usual de furadeiras. Use `"front"` para inverter a convenção.

### Como identificar o mesh do mandril (outro modelo)

1. Abra o console (F12): a **hierarquia completa** é impressa ao carregar.
2. **Clique numa peça** (desktop): o nome e a cadeia de pais aparecem no
   console e na barra de status, e a peça fica destacada em amarelo.
3. Helpers no console:
   * `drill.findCandidates()` — nós com "mandril", "chuck", "castanha"…
   * `drill.highlight("MONTAGEM MANDRIL")` — destaca um nó pelo nome
   * `drill.setModelRotationDeg(0, 180, 0)` — testa a orientação do modelo
4. Copie os nomes para `CHUCK.nodes` / `CHUCK.axisNode`. Se o eixo estiver
   errado, troque `axisLocal` entre `[1,0,0]`, `[0,1,0]` e `[0,0,1]`.

### Como a rotação é aplicada

Para cada grupo é criado um `TransformNode` pivô sobre o eixo, sob o **mesmo
pai** das peças. As peças são re-parenteadas com `setParent` (preserva a
posição no mundo; **a geometria não é alterada**). A cada quadro:

```
ω = RPM × 2π / 60          (rad/s)
θ += ω × dt × fatorVisual  (dt = delta time real)
pivô.rotationQuaternion = RotationAxis(eixoLocal, θ)
```

A rotação é local ao pivô, portanto independe da câmera, da vibração e de
qualquer movimento da furadeira.

### Efeito estroboscópico (importante)

A 3000 RPM o mandril dá 50 voltas por segundo. Num display de 72–90 Hz isso
dá ~200° por quadro e o olho vê a peça parada ou girando ao contrário (efeito
"roda de carroça"). Por isso, por padrão, a velocidade **exibida** é
multiplicada por `VISUAL.antiStrobeFactor = 0.15`, mantendo a proporção entre
velocidades. **O RPM mostrado nas interfaces é sempre o real.** Para rotação
fisicamente exata, marque "Velocidade visual real (1:1)" no painel ou use
`antiStrobeFactor = 1`.

### Girar à mão (manivela)

* **Browser:** arraste a manivela (mouse ou dedo) em círculo. Arrastar fora
  das peças que giram continua orbitando a câmera.
* **Meta Quest:** encoste o controle na manivela, aperte o **grip** e gire a
  mão em círculo (o controle vibra a cada 30° de giro).

A peça segue a mão e o trem de engrenagens gira nas relações reais: uma volta
da manivela ≈ **16,4 voltas do mandril**. O RPM exibido vem da velocidade da
mão; ao soltar, a furadeira desacelera por inércia. Pegar a manivela desliga
o motor; ligar o motor solta a manivela. Também dá para agarrar uma
engrenagem ou o próprio mandril. Funciona com a vista explodida e no modo
aproximar. Ajustes em `HAND_DRIVE` (`src/config.ts`).

### Vista explodida

Botão **EXPLODIR/MONTAR** e slider no painel (HTML e VR), tecla **E**, ou
thumbstick esquerdo ↑/↓ no Quest. Console: `drill.explode()` / `drill.explode(0.5)`.

* Peças fixas se afastam do centro da montagem, com reforço nas direções
  transversais ao comprimento (`EXPLODE.crossBoost`), e nunca afundam na bancada.
* Grupos que giram (mandril, engrenagens, manivela) se afastam inteiros e,
  dentro deles, as peças se separam **ao longo do próprio eixo**, por isso a
  furadeira pode ser ligada explodida e tudo continua girando corretamente.
* Ajustes em `EXPLODE` (`src/config.ts`): `spread`, `crossBoost`,
  `minDistance`, `axialSpread`, `duration`.

---

## 8. Integração ESP32 (WebSocket)

**Controle físico pronto:** firmware para ESP32 + encoder KY-040 em
[`firmware/`](firmware/README.md) (ligação, bibliotecas, upload). Sem
hardware, teste com `npm run esp32:sim`.

1. Grave o firmware e anote o IP do ESP32 no Monitor Serial.
2. Crie `.env.local` com `ESP32_HOST=<ip>` (veja `.env.example`) e reinicie o `npm run dev`.
3. No painel, **Integração ESP32 → CONECTAR** (URL sugerida `…/esp32`).

O servidor do Vite repassa `ws(s)://<pc>:5173/esp32` para o ESP32. Por isso
funciona também com a página em HTTPS no Meta Quest. Mensagens aceitas:

```json
{"rpm":1500,"power":true,"direction":1}
```

Todos os campos são opcionais (`power` aceita `true/false` ou `1/0`;
`direction` = `1` ou `-1`). Ao receber, a aplicação atualiza velocidade,
estado, sentido e as duas interfaces. A cada mudança de estado a página envia
`{"type":"state","rpm":…,"power":…,"direction":…}` ao ESP32. Há reconexão
automática com espera progressiva.

Teste sem hardware, no console: `drill.simulateMessage({rpm:2000, power:true, direction:-1})`.

> **Conteúdo misto:** uma página em **HTTPS** só pode abrir **`wss://`**, por
> isso a URL padrão é a ponte `/esp32` do servidor Vite (`npm run dev` /
> `dev:https` / `preview`). Se a página for publicada num site estático, não
> há ponte: use TLS no ESP32 ou um pequeno servidor-ponte na rede local.

---

## 9. Estrutura do código

```
public/models/furadeira.glb   modelo (carregado uma única vez, sem clonagem)
src/
  main.ts              inicialização e orquestração (cena → modelo → WebXR)
  config.ts            ★ configurações: modelo, mandril, eixo, pivô, VR, WebSocket
  scene.ts             cena Babylon: câmera, luzes, IBL, piso, bancada, sombras
  modelLoader.ts       carregamento do GLB (SceneLoader) e hierarquia no console
  placement.ts         posição/orientação da furadeira, modo "aproximar"
  drillController.ts   estado e rampa de velocidade (sem dependência de Babylon)
  mandrelAnimation.ts  pivôs, rotação do mandril/engrenagens, broca, vibração
  webxr.ts             sessão VR, teletransporte, mapeamento modular dos controles
  ui.ts                painel HTML (mouse e toque)
  vrPanel.ts           painel 3D dentro do headset
  websocket.ts         ponte WebSocket para ESP32
  style.css            visual de painel industrial
```

A lógica (`drillController.ts`) é separada da animação (`mandrelAnimation.ts`),
da interface (`ui.ts`, `vrPanel.ts`) e do VR (`webxr.ts`): todas as entradas
(HTML, painel VR, controles do Quest, ESP32) chamam as mesmas funções:
`setMandrilRPM(rpm)`, `startDrill()`, `stopDrill()`, `setRotationDirection(direction)`.

## 10. Desempenho (Meta Quest)

* Fora do VR a cena só é redesenhada quando algo muda (câmera, rotação, UI).
* Animações usam delta time real (independentes da taxa de quadros).
* Materiais do GLB e da cena são congelados depois de prontos.
* Sombras: dinâmicas no desktop, estáticas no VR (economia de GPU).
* Malhas do modelo deixam de ser "clicáveis" no VR (menos testes de raio).
* Textos do painel VR são atualizados a no máximo 12 Hz.
* Vibração reduzida no VR (`VISUAL.vibration.xrFactor`) e opcional.
* Densidade de pixels limitada a 2× em celulares.

Se o carregamento no celular ficar lento, o GLB pode ser comprimido com Draco
sem alterar código (os nomes dos nós são preservados):

```bash
npx @gltf-transform/cli draco public/models/furadeira.glb public/models/furadeira-draco.glb
```

e então aponte `MODEL.url` para `furadeira-draco.glb`.

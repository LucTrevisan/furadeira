/**
 * ============================================================================
 *  CONFIGURAÇÃO CENTRAL — ajuste aqui o modelo, o mandril, o eixo e o pivô.
 * ============================================================================
 *
 * COMO IDENTIFICAR O MESH DO MANDRIL
 * ----------------------------------
 * 1. Rode a aplicação e abra o console do navegador (F12). Ao carregar o GLB,
 *    a hierarquia completa é impressa (nome de cada nó, tipo, nº de vértices).
 * 2. No desktop, CLIQUE em uma peça: o console mostra o nome da peça e a
 *    cadeia de pais até a raiz, e a peça fica destacada em amarelo.
 * 3. No console também há o helper `drill.highlight("NOME")`, para destacar
 *    um nó pelo nome, e `drill.findCandidates()`, que lista os nós cujo nome
 *    contém "mandril", "chuck", "castanha" etc.
 * 4. Copie os nomes EXATOS (incluindo espaços duplos) para `CHUCK.nodes`.
 *
 * Os nomes abaixo NÃO foram inventados: foram extraídos da hierarquia do
 * arquivo `public/models/furadeira.glb` (exportado pelo SolidWorks):
 *
 *   MONTAGEM MAQUINA DE FURAR MANUAL
 *   ├─ MONTAGEM MANDRIL                 ← submontagem do mandril (separada ✔)
 *   │   ├─ CORPO ROSCADO-1              ← corpo do mandril (eixo local Y)
 *   │   ├─ CAPA DO MANDRIL-1
 *   │   └─ SUBMONT CASTANHAS            ← castanhas, cone de ajuste, molas
 *   ├─ EIXO DO MANDRIL-1                ← eixo-árvore (mesmo eixo do mandril)
 *   ├─ PINHAOZ 15 a-1                   ← pinhão Z15 montado no eixo-árvore
 *   ├─ COROA Z 30-1 / ENGRENAGEM MAIOR M1_Z15 a-1 / EIXO DAS ENGRENAGENS-5
 *   ├─ ENGREN MENOR MOD 1  Z 43 a-1 / ENGRENAGEM MENOR M1_Z15 a-1 / EIXO DAS ENGRENAGENS 2-1
 *   ├─ ENGREN MAIOR MOD 1  Z 43 a-1 / EIXO DAS ENGRENAGENS 3-1
 *   └─ SUBMONT MANIVELA                 ← manivela (gira no eixo da Z43 maior)
 *
 * O MODELO NÃO CONTÉM BROCA. Por isso existe `BIT` (abaixo): uma broca
 * procedural simples, criada em código e presa ao mandril. Ela não altera o
 * GLB e pode ser desligada com `BIT.enabled = false`.
 *
 * SE O MANDRIL ESTIVER FUNDIDO AO CORPO (em outro modelo)
 * ------------------------------------------------------
 * Se a hierarquia mostrar um único mesh para "furadeira inteira", não há
 * como girar só o mandril sem cortar a malha. Solução correta: no CAD
 * (SolidWorks/Fusion/Blender), separar o mandril como peça/objeto próprio,
 * com o nome claro (ex.: "MANDRIL") e reexportar o GLB. Alternativa
 * paliativa: esconder a região do mandril e sobrepor um mandril procedural.
 */

export type Vec3 = [number, number, number];

/** Grupo de nós do GLB que giram juntos em torno de um mesmo eixo. */
export interface RotatingGroupConfig {
  id: string;
  /** Nomes EXATOS dos nós do GLB que giram juntos (os filhos acompanham). */
  nodes: string[];
  /** Nó cujo eixo local define o eixo de rotação. */
  axisNode: string;
  /** Eixo, nas coordenadas LOCAIS de `axisNode` (ex.: [0,1,0] = Y local). */
  axisLocal: Vec3;
  /**
   * Ponto de rotação (pivô), nas coordenadas LOCAIS de `axisNode`.
   * Se omitido, usa o centro da caixa envolvente de `axisNode`
   * (correto para peças de revolução, como corpo do mandril e engrenagens).
   */
  pivotLocal?: Vec3;
  /**
   * Velocidade angular relativa ao eixo-árvore (com sinal).
   * 1 = mesma velocidade do mandril.
   */
  ratio: number;
}

/** Caminho do GLB (pasta `public/`, copiada para a raiz do build). */
export const MODEL = {
  url: `${import.meta.env.BASE_URL}models/furadeira.glb`,
  /**
   * Correção de orientação aplicada ao modelo inteiro (graus).
   * Teste ao vivo no console: `drill.setModelRotationDeg(x, y, z)`.
   * y = 180: manivela voltada para o usuário, mandril à esquerda.
   */
  rotationDeg: { x: 0, y: 180, z: 0 },
  /**
   * Escala do modelo. O SolidWorks exporta em metros (comprimento real
   * ≈ 0,40 m), então 1 = escala real — ideal para VR.
   */
  scale: 1,
  /** Remove câmeras e luzes que vêm dentro do GLB (vistas do SolidWorks). */
  removeEmbeddedCamerasAndLights: true,
};

/** Mandril + eixo-árvore + pinhão: todos no mesmo eixo (verificado no GLB). */
export const CHUCK: RotatingGroupConfig = {
  id: "mandril",
  nodes: ["MONTAGEM MANDRIL", "EIXO DO MANDRIL-1", "PINHAOZ 15 a-1"],
  axisNode: "CORPO ROSCADO-1",
  axisLocal: [0, 1, 0],
  // pivotLocal: [0, 0, 0],  // descomente para forçar um pivô manual
  ratio: 1,
};

/**
 * Trem de engrenagens (opcional). Relações calculadas a partir do número de
 * dentes e da distância entre eixos medida no GLB (29 mm = par Z43/Z15, m=1):
 *
 *   manivela + Z43 maior  ──engrena──▶ Z15 menor  (eixo 2, junto com Z43 menor)
 *   Z43 menor             ──engrena──▶ Z15 maior  (eixo 5, junto com coroa Z30)
 *   coroa Z30             ──engrena──▶ pinhão Z15 (eixo-árvore / mandril)
 *
 * Velocidade da manivela = (15/30)·(15/43)² ≈ 0,061 × mandril.
 * Defina `GEAR_TRAIN.enabled = false` para girar somente o mandril.
 */
const Z = { coroa: 30, pinhao: 15, z43: 43, z15: 15 };
const RATIO_SHAFT5 = Z.pinhao / Z.coroa; //  +0,5
const RATIO_SHAFT2 = -RATIO_SHAFT5 * (Z.z15 / Z.z43); // −0,174
const RATIO_CRANK = RATIO_SHAFT5 * (Z.z15 / Z.z43) ** 2; // +0,061

export const GEAR_TRAIN: { enabled: boolean; groups: RotatingGroupConfig[] } = {
  enabled: true,
  groups: [
    {
      id: "eixo5-coroa",
      nodes: ["COROA Z 30-1", "ENGRENAGEM MAIOR M1_Z15 a-1", "EIXO DAS ENGRENAGENS-5"],
      axisNode: "COROA Z 30-1",
      axisLocal: [1, 0, 0],
      ratio: RATIO_SHAFT5,
    },
    {
      id: "eixo2",
      nodes: ["ENGREN MENOR MOD 1  Z 43 a-1", "ENGRENAGEM MENOR M1_Z15 a-1", "EIXO DAS ENGRENAGENS 2-1"],
      axisNode: "ENGREN MENOR MOD 1  Z 43 a-1",
      axisLocal: [1, 0, 0],
      ratio: RATIO_SHAFT2,
    },
    {
      id: "eixo3-manivela",
      nodes: ["ENGREN MAIOR MOD 1  Z 43 a-1", "EIXO DAS ENGRENAGENS 3-1", "SUBMONT MANIVELA"],
      axisNode: "ENGREN MAIOR MOD 1  Z 43 a-1",
      axisLocal: [1, 0, 0],
      ratio: RATIO_CRANK,
    },
  ],
};

/** Broca procedural (o GLB não possui broca). Gira junto com o mandril. */
export const BIT = {
  enabled: true,
  diameter: 0.006, // m
  length: 0.07, // m (comprimento total)
  insertion: 0.018, // m (quanto fica dentro das castanhas)
};

export const DRILL = {
  maxRPM: 3000,
  defaultRPM: 1200,
  /** Passo dos botões +/− (RPM). */
  rpmStep: 100,
  /** Variação de RPM por segundo ao segurar os botões laterais do controle VR. */
  rpmHoldRate: 900,
  /** Aceleração ao ligar (RPM/s) e desaceleração ao desligar (RPM/s). */
  spinUpRate: 2500,
  spinDownRate: 1500,
  /**
   * Sentido "horário" visto POR TRÁS da ferramenta (posição do operador,
   * olhando para a ponta da broca) — convenção usual de furadeiras.
   * Troque para "front" se quiser o horário visto de frente para a broca.
   */
  clockwiseViewedFrom: "behind" as "behind" | "front",
};

/**
 * Acionamento manual: arrastar a manivela (mouse/toque) ou agarrá-la com o
 * grip do Quest. A peça segue a mão e move todo o trem de engrenagens; o
 * mandril gira 1/0,0608 ≈ 16,4 voltas por volta da manivela.
 * Qualquer peça que gira (mandril, engrenagens) também pode ser agarrada.
 */
export const HAND_DRIVE = {
  enabled: true,
  /** Distância máxima (m) entre o controle VR e a peça para agarrá-la. */
  grabDistance: 0.06,
  /** Suavização do RPM exibido enquanto gira à mão (s). */
  smoothing: 0.12,
  /** Pulso de vibração do controle a cada fração de volta da peça agarrada (0 = sem). */
  hapticEveryTurn: 1 / 12,
};

/**
 * Vista explodida.
 *  - Peças fixas: afastam-se do centro da montagem
 *      deslocamento = (centroPeça − centroMontagem) × spread + direção × minDistance
 *  - Peças que giram (mandril, engrenagens, manivela): o grupo inteiro se
 *    afasta do centro e, dentro dele, as peças se separam AO LONGO DO EIXO
 *    (axialSpread), de modo que continuam girando corretamente explodidas.
 */
export const EXPLODE = {
  spread: 0.9,
  /**
   * Reforço nas direções transversais ao comprimento da furadeira: sem ele,
   * numa peça longa e fina, tudo se espalharia quase só no comprimento e as
   * engrenagens mal sairiam da carcaça.
   */
  crossBoost: 1.8,
  minDistance: 0.03, // m
  axialSpread: 1.1,
  duration: 1.4, // s (montar/explodir)
  /** Velocidade do thumbstick esquerdo (↑/↓) no VR, em fração por segundo. */
  xrRate: 0.8,
};

export const VISUAL = {
  /**
   * Efeito estroboscópico: a 3000 RPM o mandril dá 50 voltas/s; a 72–90 Hz
   * (Quest) isso são ~200° por quadro, e o olho vê a peça "parada" ou girando
   * ao contrário (efeito roda de carroça). O fator abaixo multiplica apenas a
   * velocidade EXIBIDA, mantendo a proporção entre RPMs (o RPM mostrado na
   * interface é sempre o real). Use 1 para velocidade física exata.
   * Pode ser alternado na interface ("Velocidade visual real").
   */
  antiStrobeFactor: 0.15,
  antiStrobeEnabledByDefault: true,
  vibration: {
    /**
     * Vibração SIMULADA pelo motor (proporcional ao RPM). Desligada: o modelo
     * só vibra com dados reais do acelerômetro (MPU6050, ver IOT). true = volta
     * o efeito simulado.
     */
    enabled: false,
    /** Amplitude máxima em metros a 3000 RPM (0,25 mm). */
    amplitude: 0.00025,
    /** Multiplicador da amplitude dentro do VR (menor = mais confortável). */
    xrFactor: 0.5,
  },
  /** Taxa de atualização dos textos de RPM (Hz) — poupa DOM e texturas GUI. */
  uiRefreshHz: 12,
  shadows: true,
  /** Clique em peças para identificá-las (somente desktop). */
  debugPick: true,
  /**
   * Pós-processamento SOMENTE no desktop (a câmera do VR é outra e não o
   * recebe): oclusão de ambiente (SSAO2), antisserrilhamento e tone mapping.
   * SSAO desligado por padrão: custava ~90% do tempo de cada quadro. A sombra
   * de contato sob o equipamento continua. true = religa (máquinas potentes).
   */
  ssao: false,
  /** Melhora a apresentação dos materiais do CAD (ver materials.ts). */
  enhanceMaterials: true,
  /** Tela de apresentação ao abrir (uma vez por sessão; ?nosplash a desativa). */
  splash: true,
  /** Rótulos dos componentes na vista explodida (desktop). */
  explodeLabels: true,
};

/** Câmera desktop: vista inicial 3/4 e limites. */
export const CAMERA_VIEW = {
  /** Ângulo horizontal a partir da posição do operador (graus). */
  yawDeg: -34,
  /** Inclinação vertical: 0 = de cima; 90 = horizontal (graus). */
  pitchDeg: 69,
  /** Fração da largura da viewport ocupada pelo equipamento. */
  fill: 0.96,
  /** Zoom mínimo/máximo em relação à distância inicial. */
  minZoom: 0.3,
  maxZoom: 2.6,
};

export const SCENE = {
  tableHeight: 0.9, // m
  tableSize: { width: 1.4, depth: 0.7 },
  /** Centro da furadeira (x, z) sobre a mesa. Usuário inicia em (0, 0) olhando +Z. */
  drillPosition: { x: 0, z: 0.6 },
  /** Posição do usuário ao entrar no VR (x, z). */
  xrStart: { x: 0, z: 0.05 },
  /** Distância da ponta do mandril aos olhos no modo "Aproximar" (VR). */
  inspectDistance: 0.32,
  /**
   * Folga (m) entre a bancada e o ponto mais baixo que as peças que giram
   * alcançam (punho da manivela). A furadeira é erguida automaticamente.
   */
  drillClearance: 0.015,
};

/**
 * Mapeamento modular dos controles Meta Quest.
 * Ids de componentes do perfil WebXR "oculus-touch": xr-standard-trigger,
 * xr-standard-squeeze, xr-standard-thumbstick, a-button, b-button,
 * x-button, y-button.
 *  - press   → dispara uma vez ao apertar
 *  - release → dispara uma vez ao soltar
 *  - hold    → dispara a cada quadro enquanto apertado (recebe dt)
 *  - axes    → dispara a cada quadro com os eixos do thumbstick
 */
export type XRAction =
  | "triggerOn"
  | "triggerOff"
  | "rpmUp"
  | "rpmDown"
  | "toggleDirection"
  | "togglePower"
  | "toggleInspect"
  | "reset"
  | "rotateModel"
  | "explode"
  | "grabStart"
  | "grabEnd";

export interface XRBinding {
  hand: "left" | "right";
  component: string;
  on: "press" | "release" | "hold" | "axes";
  action: XRAction;
}

export const XR_BINDINGS: XRBinding[] = [
  // Gatilho direito: liga enquanto pressionado; ao soltar, desliga.
  { hand: "right", component: "xr-standard-trigger", on: "press", action: "triggerOn" },
  { hand: "right", component: "xr-standard-trigger", on: "release", action: "triggerOff" },
  // Grip perto da manivela (ou de engrenagem/mandril): agarra e gira à mão.
  { hand: "right", component: "xr-standard-squeeze", on: "press", action: "grabStart" },
  { hand: "right", component: "xr-standard-squeeze", on: "release", action: "grabEnd" },
  { hand: "left", component: "xr-standard-squeeze", on: "press", action: "grabStart" },
  { hand: "left", component: "xr-standard-squeeze", on: "release", action: "grabEnd" },
  // Grip longe das peças: direito aumenta, esquerdo diminui o RPM.
  { hand: "right", component: "xr-standard-squeeze", on: "hold", action: "rpmUp" },
  { hand: "left", component: "xr-standard-squeeze", on: "hold", action: "rpmDown" },
  // Botão de seleção (A): inverte o sentido.
  { hand: "right", component: "a-button", on: "press", action: "toggleDirection" },
  // B: liga/desliga (modo travado, sem segurar o gatilho).
  { hand: "right", component: "b-button", on: "press", action: "togglePower" },
  // X: aproximar/afastar o mandril dos olhos. Y: reset.
  { hand: "left", component: "x-button", on: "press", action: "toggleInspect" },
  { hand: "left", component: "y-button", on: "press", action: "reset" },
  // Thumbstick esquerdo: gira a furadeira para ver de outros ângulos.
  { hand: "left", component: "xr-standard-thumbstick", on: "axes", action: "rotateModel" },
  // Thumbstick esquerdo (↑/↓): explode / monta a furadeira.
  { hand: "left", component: "xr-standard-thumbstick", on: "axes", action: "explode" },
];

export const WEBSOCKET = {
  /**
   * URL padrão do ESP32 (pode ser alterada na interface ou via ?ws=...).
   * "auto" = ponte do próprio servidor Vite: ws(s)://<host da página>/esp32,
   * que funciona também em HTTPS/Meta Quest (ver vite.config.ts e .env.example).
   * Para conectar direto no ESP32 (página em HTTP): "ws://192.168.x.x:81".
   */
  defaultUrl: "auto",
  /**
   * Conecta ao abrir a página. "local" = automaticamente quando a página vem
   * da rede local (localhost, 192.168.x.x, *.local…), onde a ponte /esp32
   * existe; em sites publicados (GitHub Pages) só se o usuário pedir.
   * Sem ESP32 a aplicação segue no MODO NORMAL, sem nenhuma diferença.
   */
  autoConnect: "local" as boolean | "local",
  /** Reconexão: 1 s, 2 s, 5 s e depois a cada 10 s. */
  reconnectDelaysMs: [1000, 2000, 5000, 10000],
  /**
   * Via padrão até o ESP32: "mqtt" (broker; funciona também no GitHub Pages)
   * ou "websocket" (ponte /esp32 do "npm run dev"). Pode ser trocada na
   * interface (IoT / Hardware); a escolha fica salva no navegador.
   */
  // APRESENTAÇÃO: WebSocket local (ESP32 e notebook na mesma rede, "npm run dev").
  transport: "websocket" as "mqtt" | "websocket",
};

/**
 * Broker MQTT. A página usa MQTT sobre WebSocket seguro (wss) na porta 443 —
 * a mesma do HTTPS, liberada até em redes corporativas que bloqueiam as portas
 * de MQTT (1883/8883/8884). Funciona em páginas HTTPS (GitHub Pages, Quest).
 * O tópico precisa ser o MESMO do firmware (MQTT_TOPIC).
 * Padrão: shiftr.io público (usuário/senha "public", credenciais públicas).
 */
export const MQTT = {
  url: "wss://public.cloud.shiftr.io:443",
  topic: "senai-furadeira/d3f5f010",
  username: "public",
  password: "public",
  /** Brokers padrão anteriores: preferências salvas com eles migram para o atual. */
  legacyUrls: ["wss://broker.hivemq.com:8884/mqtt"],
  /** A aplicação avisa a placa que está ativa a cada N ms (o LCD usa isso). */
  heartbeatMs: 5000,
};

/** Camada IoT (ESP32 + KY-040 + MPU6050 + HC-SR04 + LCD). */
export const IOT = {
  /** Log no console: [ESP32], [KY040], [MPU6050], [HC-SR04]. */
  debug: false,
  /** Deslocamento visual máximo (m) quando o MPU6050 indica 100 % de vibração. */
  vibrationAmplitude: 0.0012,
  /** Suavização da vibração visual (s). */
  vibrationSmoothing: 0.12,
  /** Faixas (%) usadas se o ESP32 não informar o nível. Calibráveis. */
  levels: { attention: 30, high: 70 },
  /**
   * Forma de onda REAL do acelerômetro (mensagens "osc", 100 Hz): o modelo
   * oscila exatamente como o sensor. Deslocamento = aceleração (g) × ganho.
   */
  osc: {
    /** Metros de deslocamento por g de aceleração (0,35 g → ~2 mm). */
    gainMetersPerG: 0.006,
    /** Deslocamento máximo (m), em qualquer eixo. */
    maxOffset: 0.004,
    /**
     * Eixo do SENSOR que move cada eixo do MODELO (sinal inverte o sentido).
     * Padrão: MPU6050 deitado (Z do sensor para cima) → Y do modelo.
     */
    axes: { x: "+x", y: "+z", z: "+y" } as Record<"x" | "y" | "z", string>,
    /** Amostras acumuladas antes de começar a tocar (absorve o atraso da rede). */
    prebuffer: 6,
  },
};

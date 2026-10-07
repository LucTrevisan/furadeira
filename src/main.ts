import "./style.css";
import { type AbstractMesh, Engine, type Material, Matrix, type Node, RenderTargetTexture, ShadowGenerator, Vector3 } from "@babylonjs/core";
import { ComponentInspector } from "./components";
import { CAMERA_VIEW, DRILL, EXPLODE, HAND_DRIVE, IOT, MODEL, SCENE, VISUAL, type XRAction } from "./config";
import { enhanceMaterials } from "./materials";
import { TrainingModule } from "./training";
import { startUpdateCheck, versionLabel } from "./version";
import { HandDrive } from "./handDrive";
import { DrillController } from "./drillController";
import { ExplodedView } from "./explodedView";
import { MandrelAnimation, VibrationEffect } from "./mandrelAnimation";
import { findCandidates, type LoadedModel, loadModel, printHierarchy, worldBoundsOf } from "./modelLoader";
import { DrillPlacement } from "./placement";
import { addContactShadow, createScene, setupDesktopPostProcess } from "./scene";
import { ControlPanelUI } from "./ui";
import { VRPanel } from "./vrPanel";
import { checkVRSupport, setupXR, type XRActionContext, type XRSetup } from "./webxr";
import {
  Esp32Link,
  type IoTSensors,
  type IoTTelemetry,
  loadLinkPrefs,
  saveLinkPrefs,
  shouldAutoConnect,
  toTarget,
} from "./websocket";

// Erros nunca ficam silenciosos: aparecem na barra de status.
const statusEl = document.getElementById("statusMsg");
const showFatal = (msg: string): void => {
  if (statusEl) {
    statusEl.textContent = "Erro: " + msg;
    statusEl.className = "status error";
  }
  document.getElementById("loading")?.classList.add("hidden");
};
window.addEventListener("error", (e) => showFatal(e.message));
window.addEventListener("unhandledrejection", (e) => showFatal(String(e.reason?.message ?? e.reason)));

async function main(): Promise<void> {
  const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
  const drill = new DrillController();

  // Estado compartilhado (preenchido nas seções B e C).
  let model: LoadedModel | null = null;
  let anim: MandrelAnimation | null = null;
  let placement: DrillPlacement | null = null;
  let vibration: VibrationEffect | null = null;
  let explode: ExplodedView | null = null;
  let handDrive: HandDrive | null = null;
  let vrPanel: VRPanel | null = null;
  let xrSetup: XRSetup | null = null;
  let inXR = false;
  let triggerHeld = false;
  let inspector: ComponentInspector | null = null;
  let pendingExplode: boolean | null = null;
  // Reprodução da forma de onda do acelerômetro (amostras em g, 100 Hz).
  const osc = { queue: [] as number[][], periodMs: 10, acc: 0, playing: false, lastRx: 0, target: Vector3.Zero(), cur: Vector3.Zero() };
  const oscActive = (): boolean => performance.now() - osc.lastRx < 400 || osc.cur.lengthSquared() > 1e-12;
  /** Eixo do sensor → eixo do modelo (IOT.osc.axes), em metros. */
  const oscToOffset = (s: number[], out: Vector3): void => {
    const pick = (spec: string): number => {
      const i = { x: 0, y: 1, z: 2 }[spec.slice(-1) as "x" | "y" | "z"] ?? 0;
      return (spec.startsWith("-") ? -1 : 1) * s[i];
    };
    const g = IOT.osc.gainMetersPerG;
    const m = IOT.osc.maxOffset;
    const c = (v: number): number => Math.max(-m, Math.min(m, v * g));
    out.set(c(pick(IOT.osc.axes.x)), c(pick(IOT.osc.axes.y)), c(pick(IOT.osc.axes.z)));
  };
  /**
   * Toca a fila no ritmo REAL das amostras (independe dos FPS): após um
   * pequeno buffer inicial, consome periodMs de amostra a cada periodMs de tempo.
   * Sem dados novos, o modelo volta suavemente à posição original.
   */
  const playOsc = (dt: number, scale: number, outPos: Vector3): void => {
    if (!osc.playing && osc.queue.length >= IOT.osc.prebuffer) osc.playing = true;
    if (osc.playing) {
      osc.acc += dt * 1000;
      while (osc.acc >= osc.periodMs && osc.queue.length) {
        oscToOffset(osc.queue.shift()!, osc.target);
        osc.acc -= osc.periodMs;
      }
      if (!osc.queue.length) {
        osc.playing = false;
        osc.acc = 0;
      }
    }
    if (performance.now() - osc.lastRx > 400) osc.target.setAll(0);
    Vector3.LerpToRef(osc.cur, osc.target, Math.min(1, dt * 60 * 0.7), osc.cur);
    if (osc.cur.lengthSquared() < 1e-12) osc.cur.setAll(0);
    outPos.copyFrom(osc.cur).scaleInPlace(scale);
  };
  let ssaoPipeline: import("@babylonjs/core").SSAO2RenderingPipeline | null = null;
  // Desempenho: se o desktop não sustentar ~30 FPS com SSAO, ele é desligado.
  const perf = { frames: 0, time: 0, checked: false, step: 0 };
  // Câmera desktop: visão geral (definida após carregar) e foco no mandril.
  let homeView: { target: Vector3; radius: number } | null = null;
  let focused = false;
  let savedView: { alpha: number; beta: number; radius: number; target: Vector3 } | null = null;

  // ===================== A. Motor, cena e loop de renderização ==============
  const engine = new Engine(canvas, true, { stencil: true, powerPreference: "high-performance" }, false);
  // Limita a densidade de pixels (celulares com DPR 3 ficariam pesados à toa).
  // Telas de alta densidade: no máximo 1,5× (a 2× são 78% mais pixels por quadro).
  engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 1.5));
  const ctx = createScene(engine, canvas);
  const { scene, camera } = ctx;
  camera.inputs.removeByType("ArcRotateCameraKeyboardMoveInput"); // setas = RPM
  // Vista 3/4 padrão do equipamento.
  const HOME_ALPHA = -Math.PI / 2 + (CAMERA_VIEW.yawDeg * Math.PI) / 180;
  const HOME_BETA = (CAMERA_VIEW.pitchDeg * Math.PI) / 180;

  // Ligação com o ESP32: parâmetros da URL > escolha salva neste navegador > config.ts.
  const linkPrefs = loadLinkPrefs();
  // MQTT conecta sozinho em qualquer lugar (inclusive GitHub Pages); o WebSocket
  // local só na rede local. Se o usuário desconectou antes, respeita.
  const wsAutoConnect =
    linkPrefs.connect ?? (linkPrefs.settings.transport === "mqtt" ? true : shouldAutoConnect());
  let link: Esp32Link | null = null;
  const ui = new ControlPanelUI(
    drill,
    {
      onEnterVR: () => void enterVR(),
      onFocusToggle: () => toggleFocus(),
      onRealSpeedChange: (real) => {
        if (anim) anim.speedFactor = real ? 1 : VISUAL.antiStrobeFactor;
      },
      onWsToggle: (settings) => {
        if (!link) return;
        const connect = !link.isActive;
        if (connect) link.connect(toTarget(settings));
        else link.disconnect();
        saveLinkPrefs(settings, connect);
      },
      onReset: () => fullReset(),
      onExplodeToggle: () => toggleExplode(),
      onExplodeSet: (f) => explode?.setFactor(f),
      onHome: () => goHome(),
      onInspectToggle: (on) => {
        if (!inspector) return;
        inspector.enabled = on;
        if (!on) inspector.clear();
      },
      onTrainPrimary: () => training.primary(),
      onTrainStop: () => training.stop(),
    },
    linkPrefs.settings,
  );
  const training = new TrainingModule(ui.trainingView);
  // Versão visível no rodapé + atualização automática quando houver nova publicação.
  const versionEl = document.getElementById("appVersion");
  if (versionEl) versionEl.textContent = versionLabel();
  startUpdateCheck({ canReload: () => !inXR, notify: (msg) => ui.toast(msg, "info", 5000) });
  ui.setSystemState("loading", "Carregando");
  // ---- Camada IoT (ESP32). ADITIVA: sem placa, nada muda (MODO NORMAL). ----
  const iot = {
    connected: false,
    device: "",
    sensors: null as IoTSensors | null,
    telemetry: null as IoTTelemetry | null,
    /** Vibração física 0..1 (alvo vindo do MPU6050 e valor suavizado). */
    vibTarget: 0,
    vib: 0,
    dirty: true,
  };
  link = new Esp32Link(drill, {
    onStatus: (s, d) => {
      ui.setWsStatus(s, d);
      iot.connected = s === "connected";
      iot.dirty = true;
    },
    // HC-SR04: aciona a MESMA vista explodida dos botões.
    onExplode: (on) => explodeTo(on),
    onTelemetry: (t) => {
      iot.telemetry = t;
      if (t?.sensors) iot.sensors = t.sensors;
      iot.vibTarget = t && iot.sensors?.mpu6050 !== false ? t.vibrationPercent / 100 : 0;
      iot.dirty = true;
      requestRender(2);
    },
    // MPU6050: forma de onda real → fila de reprodução (tocada no render loop).
    onOsc: (samples, dtMs) => {
      osc.periodMs = dtMs;
      osc.queue.push(...samples);
      if (osc.queue.length > 40) osc.queue.splice(0, osc.queue.length - 12); // atraso grande: alcança o tempo real
      osc.lastRx = performance.now();
      requestRender(2);
    },
    onHello: (h) => {
      iot.device = h.device;
      iot.sensors = h.sensors;
      iot.dirty = true;
    },
  });

  if (engine.webGLVersion < 2) ui.setStatus("Aviso: WebGL2 indisponível — usando WebGL1.", "warn");
  ui.setFocusAvailable(false);

  // ---- Renderização sob demanda: fora do VR, só desenha quando algo muda ----
  let renderBudget = 30;
  let wasBusy = false;
  const requestRender = (frames = 2): void => {
    renderBudget = Math.max(renderBudget, frames);
  };
  const cameraMoving = (): boolean =>
    camera.inertialAlphaOffset !== 0 ||
    camera.inertialBetaOffset !== 0 ||
    camera.inertialRadiusOffset !== 0 ||
    camera.inertialPanningX !== 0 ||
    camera.inertialPanningY !== 0;
  canvas.addEventListener("pointerdown", () => requestRender(5));
  canvas.addEventListener("pointermove", (e) => e.buttons && requestRender(5));
  canvas.addEventListener("wheel", () => requestRender(5), { passive: true });
  // O canvas ocupa a célula da viewport (muda ao recolher o painel): redimensiona junto.
  new ResizeObserver(() => {
    engine.resize();
    requestRender(3);
  }).observe(canvas);
  drill.onChange(() => requestRender(3));
  // ESP32: conecta só agora (os handlers acima usam requestRender).
  if (wsAutoConnect) link.connect(toTarget(linkPrefs.settings));

  // Treinamento: observa eventos da máquina (não comanda nada).
  let prevState = drill.state;
  drill.onChange((s) => {
    if (s.setpointRPM !== prevState.setpointRPM) training.notify({ type: "setpoint", rpm: s.setpointRPM });
    if (s.power !== prevState.power) training.notify({ type: "power", on: s.power });
    if (s.direction !== prevState.direction) training.notify({ type: "direction" });
    prevState = s;
  });

  // ---- Transição suave da câmera (botão FOCAR MANDRIL) ---------------------
  type Tween = { from: Vector3; to: Vector3; r0: number; r1: number; a0: number; a1: number; b0: number; b1: number; t: number };
  let tween: Tween | null = null;
  const animateCamera = (to: Vector3, radius: number, alpha = camera.alpha, beta = camera.beta): void => {
    // Menor caminho angular (evita dar a volta completa ao centralizar).
    const a0 = camera.alpha;
    const da = Math.atan2(Math.sin(alpha - a0), Math.cos(alpha - a0));
    tween = { from: camera.target.clone(), to: to.clone(), r0: camera.radius, r1: radius, a0, a1: a0 + da, b0: camera.beta, b1: beta, t: 0 };
  };

  let last = performance.now();
  let uiAccum = 0;
  engine.runRenderLoop(() => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.1); // delta time real, em segundos
    last = now;

    drill.update(dt);
    if (handDrive?.isGrabbing) {
      handDrive.update(dt); // a mão gira as peças diretamente
    } else {
      // Inércia depois de soltar a manivela: velocidade visual 1:1 (sem salto).
      anim?.update(dt, drill.signedRPM, drill.isHandDriven ? 1 : undefined);
    }
    placement?.update(dt);
    explode?.update(dt);
    const xrK = inXR ? VISUAL.vibration.xrFactor : 1;
    const amp = VISUAL.vibration.enabled ? VISUAL.vibration.amplitude * xrK : 0;
    // MPU6050: microvibração proporcional à intensidade medida, suavizada
    // (Scalar.Lerp exponencial). O VibrationEffect define offsets ABSOLUTOS
    // sobre a posição original do nó: nunca há deriva pela cena.
    iot.vib += (iot.vibTarget - iot.vib) * (1 - Math.exp(-dt / IOT.vibrationSmoothing));
    if (iot.vib < 0.002 && iot.vibTarget === 0) iot.vib = 0;
    if (oscActive() && placement) {
      // Forma de onda REAL: o modelo repete a oscilação medida pelo sensor.
      playOsc(dt, xrK, placement.vibrationNode.position);
    } else {
      // Vibração terminou: descarta sobras da fila (não tocam atrasadas depois).
      if (osc.queue.length) {
        osc.queue.length = 0;
        osc.playing = false;
        osc.acc = 0;
      }
      const physAmp = IOT.vibrationAmplitude * iot.vib * xrK;
      vibration?.update(dt, 1, amp * (drill.currentRPM / DRILL.maxRPM) + physAmp);
    }

    if (tween) {
      tween.t = Math.min(1, tween.t + dt / 0.6);
      const s = tween.t * tween.t * (3 - 2 * tween.t);
      Vector3.LerpToRef(tween.from, tween.to, s, camera.target);
      camera.radius = tween.r0 + (tween.r1 - tween.r0) * s;
      camera.alpha = tween.a0 + (tween.a1 - tween.a0) * s;
      camera.beta = tween.b0 + (tween.b1 - tween.b0) * s;
      if (tween.t >= 1) tween = null;
    }
    clampCameraTarget();

    uiAccum += dt;
    if (uiAccum >= 1 / VISUAL.uiRefreshHz) {
      uiAccum = 0;
      ui.tick(drill.currentRPM);
      if (inXR) vrPanel?.tick(drill.currentRPM);
      link?.sendLiveRpm(drill.currentRPM); // velocímetro físico (servo)
      if (iot.dirty) {
        iot.dirty = false;
        ui.setIoT(iot.connected, iot.telemetry, iot.sensors, iot.device);
      }
    }

    const busy =
      inXR || drill.isMoving || iot.vib > 0 || oscActive() || !!handDrive?.isGrabbing || !!placement?.isAnimating || !!explode?.isAnimating || tween !== null || cameraMoving() || scene.getWaitingItemsCount() > 0;
    if (wasBusy && !busy) requestRender(2); // um último quadro em repouso
    wasBusy = busy;
    if (busy || renderBudget > 0) {
      scene.render();
      if (renderBudget > 0) renderBudget--;
      if (busy && !inXR && !perf.checked) watchPerformance(dt * 1000);
    }
  });

  // ===================== B. Modelo GLB ======================================
  try {
    ui.setStatus("Carregando modelo 3D…");
    ui.setLoadingMessage("Carregando modelo 3D…");
    model = await loadModel(scene, MODEL.url, (f) => ui.setLoadingProgress(f));
    ui.setLoadingMessage("Preparando materiais e iluminação…");
    scene.activeCamera = camera;
    printHierarchy(model.root);

    placement = new DrillPlacement(scene, ctx.tableTopY);
    placement.attach(model.root);

    anim = new MandrelAnimation(scene, model);
    anim.speedFactor = VISUAL.antiStrobeEnabledByDefault ? VISUAL.antiStrobeFactor : 1;
    const report = anim.setup();
    if (!report.ok) {
      const candidates = findCandidates(model);
      console.warn("[mandril] Nós não encontrados:", report.missing, "\nCandidatos:", candidates);
      ui.setStatus(
        `Mandril não encontrado no GLB (${report.missing.join(", ")}). ` +
          `Ajuste CHUCK em src/config.ts — candidatos no console.`,
        "warn",
      );
    } else {
      if (report.missing.length) console.warn("[mandril] Nós opcionais não encontrados:", report.missing);
      console.info("[mandril] Grupos animados:", report.groups.join(", "));
      ui.setStatus(
        "Arraste para orbitar · roda ou pinça: zoom · botão direito: deslocar · clique numa peça para identificá-la" +
          (HAND_DRIVE.enabled ? " · arraste a manivela para girar à mão" : ""),
      );
    }
    // Ergue a furadeira para a manivela (e demais peças que giram) passar
    // sem tocar na bancada, com folga SCENE.drillClearance.
    {
      const sweep = report.ok ? anim.lowestSweepY() : null;
      const box = worldBoundsOf([placement.vibrationNode]);
      if (box) {
        const lowest = Math.min(box.min.y, sweep ?? box.min.y);
        const lift = ctx.tableTopY + SCENE.drillClearance - lowest;
        if (lift > 0) placement.setLift(lift);
        console.info(`[posição] furadeira erguida ${(Math.max(0, lift) * 1000).toFixed(0)} mm (manivela livre)`);
      }
    }
    vibration = new VibrationEffect(placement.vibrationNode);

    // Sombras: apenas o modelo projeta sombra na bancada.
    if (ctx.shadows) for (const m of [...model.meshes, ...anim.bitMeshes]) ctx.shadows.addShadowCaster(m, false);

    // Apresentação dos materiais (antes de congelar). Geometria intocada.
    if (VISUAL.enhanceMaterials) enhanceMaterials(model, scene);
    for (const m of anim.bitMeshes) m.isPickable = true; // a broca também é identificável

    // Materiais do GLB congelados após carregarem (menos trabalho por quadro).
    const glbMaterials = new Set(model.meshes.map((m) => m.material).filter((m): m is Material => m !== null));
    scene.executeWhenReady(() => glbMaterials.forEach((m) => m.freeze()));

    // Enquadramento a partir do tamanho real do modelo.
    const size = placement.size;
    const maxDim = Math.max(size.x, size.y, size.z);
    homeView = { target: placement.placementNode.position.clone(), radius: fitRadius() };
    camera.target.copyFrom(homeView.target);
    camera.alpha = HOME_ALPHA;
    camera.beta = HOME_BETA;
    camera.radius = homeView.radius;
    // Zoom limitado: nem dentro das peças, nem a ponto de perder o equipamento.
    camera.lowerRadiusLimit = Math.max(0.12, homeView.radius * CAMERA_VIEW.minZoom);
    camera.upperRadiusLimit = homeView.radius * CAMERA_VIEW.maxZoom;

    // Apoio visual na bancada + pós-processamento do desktop.
    addContactShadow(scene, placement.placementNode.position, size.x, size.z, ctx.tableTopY);
    ssaoPipeline = setupDesktopPostProcess(scene, camera, maxDim);

    // Painel 3D (aparece só dentro do VR), à direita da furadeira, sobre a bancada.
    vrPanel = new VRPanel(scene, drill, {
      toggleInspect: () => toggleInspect(),
      reset: () => fullReset(),
      explodeToggle: () => toggleExplode(),
      explodeSet: (f) => explode?.setFactor(f),
    });
    vrPanel.placeAt(new Vector3(SCENE.drillPosition.x + 0.45, ctx.tableTopY + 0.2, SCENE.drillPosition.z - 0.22));

    // Vista explodida: preparada com a furadeira montada e parada.
    explode = new ExplodedView(model, anim);
    if (explode.setup() > 0) {
      explode.onChange((f) => {
        ui.setExplode(f);
        vrPanel?.setExplode(f);
        if (VISUAL.explodeLabels && !inXR) inspector?.setLabelsVisible(f > 0.6);
        training.notify({ type: "explode", factor: f });
        if (f >= 0.999) link?.setExploded(true); // LCD: estado real da vista
        else if (f <= 0.001) link?.setExploded(false);
        requestRender(2);
      });
      ui.setExplodeAvailable(true);
      if (pendingExplode !== null) {
        explodeTo(pendingExplode);
        pendingExplode = null;
      }
    }

    // Girar à mão (manivela, engrenagens, mandril).
    if (HAND_DRIVE.enabled && report.ok) {
      handDrive = new HandDrive(scene, anim, drill);
      handDrive.enablePointer(camera, canvas, () => !inXR);
      handDrive.onGrabChange((grabbing) => {
        if (grabbing) {
          ui.hideTooltip();
          training.notify({ type: "handDrive" });
        }
        requestRender(3);
      });
      // Ligar o motor tira a peça da mão.
      drill.onChange((s) => {
        if (s.power) handDrive?.end();
      });
    }

    setupInspector(anim.bitMeshes);
    camera.onViewMatrixChangedObservable.add(() => {
      if (!tween) training.notify({ type: "camera" });
    });
    ui.setFocusAvailable(report.ok);

    // Remove o carregamento só com materiais/texturas prontos (limite de 10 s).
    await Promise.race([scene.whenReadyAsync(), new Promise((r) => setTimeout(r, 10000))]);
    ui.setLoadingProgress(1);
    ui.hideLoading();
    ui.setSystemState("ready", "Sistema pronto");
    if (VISUAL.splash) ui.showSplash();
    requestRender(10);
  } catch (err) {
    console.error(err);
    ui.hideLoading();
    ui.setSystemState("error", "Falha no carregamento");
    ui.setStatus(
      `Não foi possível carregar ${MODEL.url}: ${(err as Error)?.message ?? err}. ` +
        "Verifique se o arquivo está em public/models/.",
      "error",
    );
  }

  exposeConsoleHelpers();

  // ===================== C. WebXR (falha aqui não afeta A e B) =============
  try {
    const support = await checkVRSupport();
    if (!support.supported) {
      ui.setVRAvailable(false, support.reason);
      console.info("[xr]", support.reason);
      return;
    }
    xrSetup = await setupXR(scene, {
      floorMeshes: [ctx.ground],
      onAction: handleXRAction,
      onStateChange: onXRStateChange,
      onInitialPose: (cam) => {
        // Usuário começa em pé à frente da bancada, olhando para +Z.
        cam.position.x = SCENE.xrStart.x;
        cam.position.z = SCENE.xrStart.z;
      },
    });
    ui.setVRAvailable(true);
  } catch (err) {
    console.warn("[xr] WebXR indisponível:", err);
    ui.setVRAvailable(false, "WebXR indisponível neste navegador.");
  }

  // ===================== Funções auxiliares (declarações içadas) ============

  async function enterVR(): Promise<void> {
    if (!xrSetup) return;
    savedView = { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.clone() };
    camera.alpha = -Math.PI / 2; // a orientação inicial no VR herda o "yaw" desta câmera
    try {
      await xrSetup.enter();
    } catch (err) {
      restoreView();
      ui.setStatus(`Não foi possível entrar no VR: ${(err as Error)?.message ?? err}`, "error");
    }
  }

  function restoreView(): void {
    if (!savedView) return;
    camera.alpha = savedView.alpha;
    camera.beta = savedView.beta;
    camera.radius = savedView.radius;
    camera.target.copyFrom(savedView.target);
    savedView = null;
  }

  function onXRStateChange(entered: boolean): void {
    inXR = entered;
    vrPanel?.setEnabled(entered);
    // No VR o raio dos controles só precisa atingir o painel e o piso.
    model?.meshes.forEach((m) => (m.isPickable = !entered));
    inspector?.clear();
    inspector?.setLabelsVisible(!entered && (explode?.factor ?? 0) > 0.6);
    ui.setXRActive(entered);
    // Sombras: estáticas no VR (economia de GPU no Quest), dinâmicas no desktop.
    const map = ctx.shadows?.getShadowMap();
    if (map) {
      map.refreshRate = entered
        ? RenderTargetTexture.REFRESHRATE_RENDER_ONCE
        : RenderTargetTexture.REFRESHRATE_RENDER_ONEVERYFRAME;
    }
    handDrive?.end();
    if (!entered) {
      if (triggerHeld) drill.stopDrill();
      triggerHeld = false;
      restoreView();
      requestRender(5);
    }
  }

  function toggleFocus(): boolean {
    if (!anim?.isReady || !homeView) return false;
    if (!focused) {
      const c = anim.chuckWorldCenter();
      if (!c) return false;
      animateCamera(c, Math.max(camera.lowerRadiusLimit ?? 0.12, homeView.radius * 0.38));
      focused = true;
    } else {
      animateCamera(placement!.placementNode.position, homeRadius());
      focused = false;
    }
    return focused;
  }

  /** Distância que faz o equipamento ocupar CAMERA_VIEW.fill da viewport. */
  function fitRadius(): number {
    // Projeta os 8 cantos da caixa do equipamento na vista 3/4 e ajusta a
    // distância até ocuparem CAMERA_VIEW.fill da viewport (horizontal e vertical).
    const box = placement ? worldBoundsOf([placement.vibrationNode]) : null;
    if (!box) return 0.8;
    const center = box.min.add(box.max).scale(0.5);
    const corners: Vector3[] = [];
    for (const x of [box.min.x, box.max.x])
      for (const y of [box.min.y, box.max.y])
        for (const z of [box.min.z, box.max.z]) corners.push(new Vector3(x, y, z));
    const aspect = engine.getAspectRatio(camera) || 1.6;
    const proj = Matrix.PerspectiveFovLH(camera.fov, aspect, camera.minZ, camera.maxZ);
    let r = box.max.subtract(box.min).length() * 1.5;
    for (let i = 0; i < 6; i++) {
      const eye = center.add(
        new Vector3(Math.cos(HOME_ALPHA) * Math.sin(HOME_BETA), Math.cos(HOME_BETA), Math.sin(HOME_ALPHA) * Math.sin(HOME_BETA)).scale(r),
      );
      const vp = Matrix.LookAtLH(eye, center, Vector3.Up()).multiply(proj);
      let mx = 0;
      let my = 0;
      for (const c of corners) {
        const p = Vector3.TransformCoordinates(c, vp);
        mx = Math.max(mx, Math.abs(p.x));
        my = Math.max(my, Math.abs(p.y));
      }
      r *= Math.max(mx / CAMERA_VIEW.fill, my / (CAMERA_VIEW.fill * 0.9));
    }
    return r;
  }

  function homeRadius(): number {
    return (explode?.factor ?? 0) > 0.5 ? fitRadius() * 1.5 : fitRadius();
  }

  /** ⌂ Centralizar: volta à vista 3/4 com o equipamento enquadrado. */
  function goHome(): void {
    if (!placement || inXR) return;
    focused = false;
    ui.setFocused(false);
    if (placement.isInspecting) placement.goHome();
    animateCamera(placement.placementNode.position, homeRadius(), HOME_ALPHA, HOME_BETA);
    requestRender(5);
  }

  /** Impede que o deslocamento (pan) leve o equipamento para fora da tela. */
  function clampCameraTarget(): void {
    if (!homeView || !placement || inXR) return;
    const max = Math.max(placement.size.x, 0.2) * 0.9;
    const d = camera.target.subtract(placement.placementNode.position);
    const len = d.length();
    if (len > max) camera.target.copyFrom(placement.placementNode.position.add(d.scale(max / len)));
  }

  function toggleInspect(): void {
    if (!placement || !anim?.isReady) return;
    if (placement.isInspecting) {
      placement.goHome();
    } else {
      const chuck = anim.chuckWorldCenter();
      const xrCam = xrSetup?.xr.baseExperience.camera;
      const head = inXR && xrCam ? xrCam.globalPosition : camera.position;
      const fwd = inXR && xrCam ? xrCam.getDirection(Vector3.Forward()) : camera.getDirection(Vector3.Forward());
      if (chuck) placement.inspect(head, fwd, chuck);
    }
    vrPanel?.setInspecting(placement.isInspecting);
    requestRender(5);
  }

  /** Explode/monta animado; no desktop a câmera se afasta para caber tudo. */
  function toggleExplode(): void {
    if (!explode?.isReady) return;
    explodeTo(explode.factor <= 0.5);
  }

  /** Explode (true) ou monta (false) — botões, teclado, VR e HC-SR04. */
  function explodeTo(exploded: boolean): void {
    if (!explode?.isReady) {
      // Pedido (ex.: HC-SR04) antes do modelo terminar de carregar: aplica depois.
      pendingExplode = exploded;
      return;
    }
    explode.animateTo(exploded ? 1 : 0);
    if (!inXR && !focused && homeView) {
      animateCamera(placement!.placementNode.position, fitRadius() * (exploded ? 1.5 : 1));
    }
  }

  function fullReset(): void {
    handDrive?.end();
    drill.reset();
    placement?.resetPose();
    explode?.animateTo(0);
    vrPanel?.setInspecting(false);
    if (focused) {
      toggleFocus();
      ui.setFocused(false);
    }
    requestRender(5);
  }

  /** Mede o FPS durante animações; com média < 28 FPS desliga o SSAO (uma vez). */
  /**
   * Mede o FPS durante animações (4 s). Abaixo de ~28 FPS simplifica em etapas,
   * medindo de novo após cada uma: 1) SSAO · 2) sombras leves · 3) só a sombra
   * de contato. Fica fluido em máquinas modestas sem afetar as potentes.
   */
  function watchPerformance(frameMs: number): void {
    perf.frames++;
    perf.time += frameMs;
    if (perf.time < 4000) return;
    const fps = (perf.frames * 1000) / perf.time;
    perf.frames = 0;
    perf.time = 0;
    if (fps >= 28) {
      perf.checked = true;
      return;
    }
    const sg = ctx.shadows;
    if (ssaoPipeline) {
      scene.postProcessRenderPipelineManager.detachCamerasFromRenderPipeline(ssaoPipeline.name, camera);
      ssaoPipeline = null;
      console.info(`[desempenho] ${fps.toFixed(0)} FPS: SSAO desligado.`);
    } else if (sg && perf.step === 0) {
      perf.step = 1;
      sg.filteringQuality = ShadowGenerator.QUALITY_LOW;
      sg.getShadowMap()?.resize(512);
      console.info(`[desempenho] ${fps.toFixed(0)} FPS: sombras simplificadas.`);
    } else if (sg && perf.step === 1) {
      perf.step = 2;
      scene.shadowsEnabled = false; // a sombra de contato sob o equipamento continua
      console.info(`[desempenho] ${fps.toFixed(0)} FPS: sombras dinâmicas desligadas.`);
    } else {
      perf.checked = true;
      return;
    }
    ui.toast("Qualidade gráfica ajustada para manter a fluidez", "info");
  }

  /** Ações dos controles do Quest (mapeadas em XR_BINDINGS, config.ts). */
  function handleXRAction(action: XRAction, c: XRActionContext): void {
    switch (action) {
      case "triggerOn":
        // Gatilho usado para clicar no painel 3D não liga a furadeira.
        if (vrPanel && xrSetup?.isPointingAt(c.controller, vrPanel.mesh)) return;
        if (!drill.state.power) {
          drill.startDrill();
          triggerHeld = true;
        }
        break;
      case "triggerOff":
        if (triggerHeld) drill.stopDrill();
        triggerHeld = false;
        break;
      case "grabStart":
        handDrive?.tryGrabXR(c.controller);
        break;
      case "grabEnd":
        handDrive?.releaseXR(c.controller);
        break;
      case "rpmUp":
        // Grip segurando uma peça = girar à mão, não ajustar o RPM.
        if (!handDrive?.isGrabbedBy(c.controller)) {
          drill.setMandrilRPM(drill.state.setpointRPM + DRILL.rpmHoldRate * c.dt);
        }
        break;
      case "rpmDown":
        if (!handDrive?.isGrabbedBy(c.controller)) {
          drill.setMandrilRPM(drill.state.setpointRPM - DRILL.rpmHoldRate * c.dt);
        }
        break;
      case "toggleDirection":
        drill.toggleDirection();
        break;
      case "togglePower":
        triggerHeld = false;
        drill.togglePower();
        break;
      case "toggleInspect":
        toggleInspect();
        break;
      case "reset":
        fullReset();
        break;
      case "rotateModel":
        if (c.axes && Math.abs(c.axes.x) > 0.15) placement?.rotateYaw(c.axes.x * 1.6 * c.dt);
        break;
      case "explode":
        // Thumbstick para frente (y < 0) explode; para trás monta.
        if (explode && c.axes && Math.abs(c.axes.y) > 0.2) {
          explode.setFactor(explode.factor - c.axes.y * EXPLODE.xrRate * c.dt);
        }
        break;
    }
  }

  // ---- Identificação de componentes (desktop): hover + clique ------------
  function setupInspector(extra: AbstractMesh[]): void {
    if (!model) return;
    inspector = new ComponentInspector(
      scene,
      model,
      extra,
      () => !inXR && !handDrive?.isGrabbing,
      () => requestRender(3),
    );
    inspector.onHover((hit, x, y) => {
      if (handDrive?.isGrabbing) return;
      const turnable = !!hit && HAND_DRIVE.enabled && !!anim?.groupIdOfNode(hit.meshes[0] ?? null);
      canvas.style.cursor = hit ? (turnable ? "grab" : "pointer") : "";
      ui.setTooltip(hit, x, y, turnable ? "Arraste para girar à mão" : "");
    });
    inspector.onSelect((hit) => {
      ui.showComponent(hit);
      if (!hit) return;
      training.notify({ type: "component", id: hit.info.id });
      if (VISUAL.debugPick) {
        const chain: string[] = [];
        for (let n: Node | null = hit.meshes[0] ?? null; n; n = n.parent) chain.push(n.name);
        console.log(`%c[peça] ${hit.info.name} — ${hit.partName}`, "font-weight:bold;color:#f2a33a", "\n  caminho: " + chain.join("  ←  "));
      }
    });
    canvas.addEventListener("pointerleave", () => ui.hideTooltip());
  }

  /** Helpers no console do navegador: `drill.<função>(...)`. */
  function exposeConsoleHelpers(): void {
    const helpers = {
      controller: drill,
      get osc() {
        return osc;
      },
      get handDrive() {
        return handDrive;
      },
      setMandrilRPM: (rpm: number) => drill.setMandrilRPM(rpm),
      startDrill: () => drill.startDrill(),
      stopDrill: () => drill.stopDrill(),
      setRotationDirection: (d: number) => drill.setRotationDirection(d),
      listNodes: () => model && printHierarchy(model.root),
      findCandidates: () => (model ? findCandidates(model) : []),
      highlight: (name: string) => {
        const n = model?.nodesByName.get(name);
        if (!n) return console.warn("Nó não encontrado:", name);
        inspector?.highlightNode(n);
      },
      training,
      explode: (f?: number) => (f === undefined ? toggleExplode() : explode?.animateTo(f)),
      setModelRotationDeg: (x = 0, y = 0, z = 0) => {
        placement?.applyOrientation(x, y, z);
        requestRender(5);
      },
      simulateMessage: (msg: string | object) =>
        link?.handleMessage(typeof msg === "string" ? msg : JSON.stringify(msg)),
      scene,
    };
    (window as unknown as { drill: typeof helpers }).drill = helpers;
    console.info(
      "%c[ajuda] Console: drill.setMandrilRPM(1500), drill.startDrill(), drill.setRotationDirection(-1), " +
        "drill.highlight('MONTAGEM MANDRIL'), drill.findCandidates(), drill.setModelRotationDeg(0,180,0), " +
        "drill.simulateMessage({rpm:1500,power:true,direction:1})",
      "color:#9aa5b0",
    );
  }
}

main().catch((err) => {
  console.error(err);
  showFatal((err as Error)?.message ?? String(err));
});

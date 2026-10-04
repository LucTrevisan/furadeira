import "./style.css";
import {
  type AbstractMesh,
  Color3,
  Engine,
  HighlightLayer,
  type Material,
  Mesh,
  type Node,
  PointerEventTypes,
  RenderTargetTexture,
  Vector3,
} from "@babylonjs/core";
import { DRILL, EXPLODE, HAND_DRIVE, MODEL, SCENE, VISUAL, WEBSOCKET, type XRAction } from "./config";
import { HandDrive } from "./handDrive";
import { DrillController } from "./drillController";
import { ExplodedView } from "./explodedView";
import { MandrelAnimation, VibrationEffect } from "./mandrelAnimation";
import { findCandidates, type LoadedModel, loadModel, printHierarchy } from "./modelLoader";
import { DrillPlacement } from "./placement";
import { createScene } from "./scene";
import { ControlPanelUI } from "./ui";
import { VRPanel } from "./vrPanel";
import { checkVRSupport, setupXR, type XRActionContext, type XRSetup } from "./webxr";
import { Esp32Link, loadWsPreference, resolveWsUrl, saveWsPreference } from "./websocket";

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
  let highlight: HighlightLayer | null = null;
  // Câmera desktop: visão geral (definida após carregar) e foco no mandril.
  let homeView: { target: Vector3; radius: number } | null = null;
  let focused = false;
  let savedView: { alpha: number; beta: number; radius: number; target: Vector3 } | null = null;

  // ===================== A. Motor, cena e loop de renderização ==============
  const engine = new Engine(canvas, true, { stencil: true, powerPreference: "high-performance" }, false);
  // Limita a densidade de pixels (celulares com DPR 3 ficariam pesados à toa).
  engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 2));
  const ctx = createScene(engine, canvas);
  const { scene, camera } = ctx;
  camera.inputs.removeByType("ArcRotateCameraKeyboardMoveInput"); // setas = RPM

  // URL do ESP32: ?ws=… > última usada neste navegador > padrão ("auto" = ponte /esp32).
  const wsParam = new URLSearchParams(location.search).get("ws");
  const wsPref = loadWsPreference();
  const wsUrl = resolveWsUrl(wsParam ?? wsPref.url ?? WEBSOCKET.defaultUrl);
  const wsAutoConnect = wsParam !== null || wsPref.connect === true || WEBSOCKET.autoConnect;
  let link: Esp32Link | null = null;
  const ui = new ControlPanelUI(
    drill,
    {
      onEnterVR: () => void enterVR(),
      onFocusToggle: () => toggleFocus(),
      onRealSpeedChange: (real) => {
        if (anim) anim.speedFactor = real ? 1 : VISUAL.antiStrobeFactor;
      },
      onWsToggle: (url) => {
        if (!link) return;
        const connect = !link.isActive;
        if (connect) link.connect(resolveWsUrl(url));
        else link.disconnect();
        saveWsPreference({ url, connect });
      },
      onReset: () => fullReset(),
      onExplodeToggle: () => toggleExplode(),
      onExplodeSet: (f) => explode?.setFactor(f),
    },
    wsUrl,
  );
  link = new Esp32Link(drill, (s, d) => ui.setWsStatus(s, d));
  if (wsAutoConnect) link.connect(wsUrl);

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
  window.addEventListener("resize", () => {
    engine.resize();
    requestRender(3);
  });
  drill.onChange(() => requestRender(3));

  // ---- Transição suave da câmera (botão FOCAR MANDRIL) ---------------------
  let tween: { from: Vector3; to: Vector3; r0: number; r1: number; t: number } | null = null;
  const animateCamera = (to: Vector3, radius: number): void => {
    tween = { from: camera.target.clone(), to: to.clone(), r0: camera.radius, r1: radius, t: 0 };
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
    const amp = VISUAL.vibration.enabled
      ? VISUAL.vibration.amplitude * (inXR ? VISUAL.vibration.xrFactor : 1)
      : 0;
    vibration?.update(dt, drill.currentRPM / DRILL.maxRPM, amp);

    if (tween) {
      tween.t = Math.min(1, tween.t + dt / 0.6);
      const s = tween.t * tween.t * (3 - 2 * tween.t);
      Vector3.LerpToRef(tween.from, tween.to, s, camera.target);
      camera.radius = tween.r0 + (tween.r1 - tween.r0) * s;
      if (tween.t >= 1) tween = null;
    }

    uiAccum += dt;
    if (uiAccum >= 1 / VISUAL.uiRefreshHz) {
      uiAccum = 0;
      ui.tick(drill.currentRPM);
      if (inXR) vrPanel?.tick(drill.currentRPM);
    }

    const busy =
      inXR || drill.isMoving || !!handDrive?.isGrabbing || !!placement?.isAnimating || !!explode?.isAnimating || tween !== null || cameraMoving() || scene.getWaitingItemsCount() > 0;
    if (wasBusy && !busy) requestRender(2); // um último quadro em repouso
    wasBusy = busy;
    if (busy || renderBudget > 0) {
      scene.render();
      if (renderBudget > 0) renderBudget--;
    }
  });

  // ===================== B. Modelo GLB ======================================
  try {
    ui.setStatus("Carregando modelo 3D…");
    model = await loadModel(scene, MODEL.url, (f) => ui.setLoadingProgress(f));
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
        HAND_DRIVE.enabled
          ? "Pronto · arraste a MANIVELA para girar à mão · arraste o resto para orbitar, role/pinça para zoom"
          : "Pronto · arraste para girar, role/pinça para zoom, clique numa peça para identificá-la",
      );
    }
    vibration = new VibrationEffect(placement.vibrationNode);

    // Sombras: apenas o modelo projeta sombra na bancada.
    if (ctx.shadows) for (const m of [...model.meshes, ...anim.bitMeshes]) ctx.shadows.addShadowCaster(m, false);

    // Materiais do GLB congelados após carregarem (menos trabalho por quadro).
    const glbMaterials = new Set(model.meshes.map((m) => m.material).filter((m): m is Material => m !== null));
    scene.executeWhenReady(() => glbMaterials.forEach((m) => m.freeze()));

    // Enquadramento a partir do tamanho real do modelo.
    const size = placement.size;
    const maxDim = Math.max(size.x, size.y, size.z);
    camera.target.copyFrom(placement.placementNode.position);
    camera.radius = maxDim * 2.1;
    camera.lowerRadiusLimit = maxDim * 0.15;
    homeView = { target: camera.target.clone(), radius: camera.radius };

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
        requestRender(2);
      });
      ui.setExplodeAvailable(true);
    }

    // Girar à mão (manivela, engrenagens, mandril).
    if (HAND_DRIVE.enabled && report.ok) {
      handDrive = new HandDrive(scene, anim, drill);
      handDrive.enablePointer(camera, canvas, () => !inXR);
      handDrive.onGrabChange((grabbing) => {
        if (grabbing) highlight?.removeAllMeshes();
        requestRender(3);
      });
      // Ligar o motor tira a peça da mão.
      drill.onChange((s) => {
        if (s.power) handDrive?.end();
      });
    }

    if (VISUAL.debugPick) enableDebugPick();
    ui.setFocusAvailable(report.ok);
    ui.hideLoading();
    requestRender(10);
  } catch (err) {
    console.error(err);
    ui.hideLoading();
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
    highlight?.removeAllMeshes();
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
      animateCamera(c, 0.2);
      focused = true;
    } else {
      animateCamera(placement!.placementNode.position, homeView.radius);
      focused = false;
    }
    return focused;
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
    const exploding = explode.factor <= 0.5;
    explode.toggle();
    if (!inXR && !focused && homeView) {
      animateCamera(placement!.placementNode.position, homeView.radius * (exploding ? 1.6 : 1));
    }
  }

  function fullReset(): void {
    handDrive?.end();
    drill.reset();
    placement?.resetPose();
    explode?.animateTo(0);
    vrPanel?.setInspecting(false);
    if (focused) toggleFocus();
    requestRender(5);
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

  // ---- Identificação de peças (desktop): clique → nome + cadeia de pais ----
  function highlightMeshes(meshes: AbstractMesh[]): void {
    highlight ??= new HighlightLayer("destaque", scene);
    highlight.removeAllMeshes();
    for (const m of meshes) if (m instanceof Mesh) highlight.addMesh(m, Color3.Yellow());
    requestRender(5);
  }

  function enableDebugPick(): void {
    scene.onPointerObservable.add((pi) => {
      if (pi.type !== PointerEventTypes.POINTERTAP || inXR) return;
      const mesh = pi.pickInfo?.pickedMesh;
      if (!mesh || !model?.meshes.includes(mesh)) {
        highlight?.removeAllMeshes();
        requestRender(2);
        return;
      }
      const chain: string[] = [];
      for (let n: Node | null = mesh; n; n = n.parent) chain.push(n.name);
      console.log(`%c[peça] ${chain[0]}`, "font-weight:bold;color:#f5a623", "\n  caminho: " + chain.join("  ←  "));
      ui.setStatus(`Peça: ${chain.find((n) => !/_primitive\d+$/.test(n)) ?? chain[0]}`);
      highlightMeshes([mesh]);
    });
  }

  /** Helpers no console do navegador: `drill.<função>(...)`. */
  function exposeConsoleHelpers(): void {
    const helpers = {
      controller: drill,
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
        highlightMeshes([...(n instanceof Mesh ? [n] : []), ...n.getChildMeshes(false)]);
      },
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

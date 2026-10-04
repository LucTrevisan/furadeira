import {
  type AbstractMesh,
  type IWebXRTeleportationOptions,
  type Mesh,
  Scene,
  type WebXRAbstractMotionController,
  type WebXRCamera,
  type WebXRControllerComponent,
  WebXRDefaultExperience,
  WebXRFeatureName,
  type WebXRInputSource,
  WebXRSessionManager,
  WebXRState,
} from "@babylonjs/core";
import { type XRAction, type XRBinding, XR_BINDINGS } from "./config";

export interface XRActionContext {
  controller: WebXRInputSource;
  dt: number;
  axes?: { x: number; y: number };
}
export type XRActionHandler = (action: XRAction, ctx: XRActionContext) => void;

export interface XRSetupOptions {
  floorMeshes: Mesh[];
  onAction: XRActionHandler;
  /** true ao entrar no VR, false ao sair. */
  onStateChange: (inXR: boolean) => void;
  /** Chamado após a primeira pose: ajuste aqui a posição inicial do usuário. */
  onInitialPose: (camera: WebXRCamera) => void;
}

export interface XRSetup {
  xr: WebXRDefaultExperience;
  enter: () => Promise<void>;
  /** O raio deste controle está apontando para `mesh`? (ex.: painel VR) */
  isPointingAt: (controller: WebXRInputSource, mesh: AbstractMesh) => boolean;
}

/** Verifica se é possível abrir uma sessão immersive-vr neste navegador. */
export async function checkVRSupport(): Promise<{ supported: boolean; reason: string }> {
  if (!window.isSecureContext) {
    return { supported: false, reason: "VR requer HTTPS (ou localhost). A visualização 3D funciona normalmente." };
  }
  if (!("xr" in navigator)) {
    return { supported: false, reason: "Este navegador não oferece WebXR." };
  }
  const ok = await WebXRSessionManager.IsSessionSupportedAsync("immersive-vr").catch(() => false);
  return ok
    ? { supported: true, reason: "" }
    : { supported: false, reason: "Nenhum dispositivo VR disponível (use o navegador do Meta Quest)." };
}

/**
 * Configura o WebXR (Meta Quest): câmera imersiva com rastreamento de cabeça,
 * modelos dos dois controles, raio de seleção (clica no painel 3D),
 * teletransporte no piso e o mapeamento modular de botões (XR_BINDINGS).
 */
export async function setupXR(scene: Scene, opts: XRSetupOptions): Promise<XRSetup> {
  const xr = await scene.createDefaultXRExperienceAsync({
    floorMeshes: opts.floorMeshes,
    disableDefaultUI: true, // usamos o botão "ENTRAR EM VR" do HTML
    disableTeleportation: true, // habilitado abaixo, só na mão direita
    uiOptions: { sessionMode: "immersive-vr", referenceSpaceType: "local-floor" },
    optionalFeatures: false,
  });

  // Teletransporte: thumbstick DIREITO para frente. O esquerdo fica livre
  // para girar a furadeira (ação "rotateModel").
  const teleportOptions = {
    xrInput: xr.input,
    floorMeshes: opts.floorMeshes,
    forceHandedness: "right" as const,
  };
  xr.baseExperience.featuresManager.enableFeature(
    WebXRFeatureName.TELEPORTATION,
    "stable",
    teleportOptions as IWebXRTeleportationOptions,
  );

  xr.baseExperience.onStateChangedObservable.add((state) => {
    if (state === WebXRState.IN_XR) opts.onStateChange(true);
    else if (state === WebXRState.NOT_IN_XR) opts.onStateChange(false);
  });
  xr.baseExperience.onInitialXRPoseSetObservable.add((cam) => opts.onInitialPose(cam));

  bindControllers(scene, xr, opts.onAction);

  return {
    xr,
    enter: async () => {
      await xr.baseExperience.enterXRAsync("immersive-vr", "local-floor", xr.renderTarget);
    },
    isPointingAt: (controller, mesh) => xr.pointerSelection.getMeshUnderPointer(controller.uniqueId) === mesh,
  };
}

interface PolledBinding {
  binding: XRBinding;
  component: WebXRControllerComponent;
  controller: WebXRInputSource;
}

/** Liga os componentes dos controles às ações definidas em XR_BINDINGS. */
function bindControllers(scene: Scene, xr: WebXRDefaultExperience, onAction: XRActionHandler): void {
  let polled: PolledBinding[] = [];
  let last = performance.now();

  xr.input.onControllerAddedObservable.add((controller) => {
    controller.onMotionControllerInitObservable.addOnce((mc: WebXRAbstractMotionController) => {
      const hand = mc.handedness;
      for (const binding of XR_BINDINGS) {
        if (binding.hand !== hand) continue;
        const component = mc.getComponent(binding.component);
        if (!component) {
          console.info(`[xr] Controle ${hand}: componente "${binding.component}" inexistente neste perfil.`);
          continue;
        }
        if (binding.on === "press" || binding.on === "release") {
          component.onButtonStateChangedObservable.add((c) => {
            if (!c.changes.pressed) return;
            const fire = binding.on === "press" ? c.pressed : !c.pressed;
            if (fire) onAction(binding.action, { controller, dt: 0 });
          });
        } else {
          polled.push({ binding, component, controller });
        }
      }
    });
  });

  xr.input.onControllerRemovedObservable.add((controller) => {
    polled = polled.filter((p) => p.controller !== controller);
  });

  // Ações contínuas ("hold" e "axes"), com delta time real.
  scene.onBeforeRenderObservable.add(() => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (xr.baseExperience.state !== WebXRState.IN_XR) return;
    for (const p of polled) {
      if (p.binding.on === "hold" && p.component.pressed) {
        onAction(p.binding.action, { controller: p.controller, dt });
      } else if (p.binding.on === "axes") {
        onAction(p.binding.action, { controller: p.controller, dt, axes: p.component.axes });
      }
    }
  });
}

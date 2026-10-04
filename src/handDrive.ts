import { type ArcRotateCamera, PointerEventTypes, type Scene, type Vector3, type WebXRInputSource } from "@babylonjs/core";
import { HAND_DRIVE } from "./config";
import type { DrillController } from "./drillController";
import { MandrelAnimation } from "./mandrelAnimation";

type Grab =
  | { kind: "pointer"; groupId: string; lastAngle: number | null; pointerId: number }
  | { kind: "xr"; groupId: string; lastAngle: number | null; controller: WebXRInputSource };

const TWO_PI = Math.PI * 2;

/**
 * Girar a furadeira à mão: arrastar a manivela (ou uma engrenagem / o
 * mandril) com mouse ou toque, ou agarrá-la com o grip do Meta Quest.
 *
 * A peça segue o ângulo da mão em torno do próprio eixo; o resto do trem gira
 * nas relações reais (MandrelAnimation.driveBy). A velocidade medida vira o
 * RPM exibido e, ao soltar, a furadeira desacelera por inércia.
 */
export class HandDrive {
  private grab: Grab | null = null;
  private pendingDPhi = 0;
  private smoothedRPM = 0;
  private hapticAccum = 0;
  private readonly listeners = new Set<(grabbing: boolean) => void>();

  constructor(
    private readonly scene: Scene,
    private readonly anim: MandrelAnimation,
    private readonly drill: DrillController,
  ) {}

  get isGrabbing(): boolean {
    return this.grab !== null;
  }

  isGrabbedBy(controller: WebXRInputSource): boolean {
    return this.grab?.kind === "xr" && this.grab.controller === controller;
  }

  onGrabChange(cb: (grabbing: boolean) => void): void {
    this.listeners.add(cb);
  }

  /**
   * Desktop/celular: arrastar uma peça girante gira o trem; arrastar o resto
   * continua orbitando a câmera. O observador entra ANTES do da câmera.
   */
  enablePointer(camera: ArcRotateCamera, canvas: HTMLCanvasElement, isEnabled: () => boolean): void {
    this.scene.onPointerObservable.add(
      (pi) => {
        const ev = pi.event as PointerEvent;
        if (pi.type === PointerEventTypes.POINTERDOWN) {
          if (this.grab || !isEnabled() || ev.button > 0) return;
          const pick = this.scene.pick(this.scene.pointerX, this.scene.pointerY, (m) => m.isPickable && m.isEnabled());
          const groupId = pick?.hit ? this.anim.groupIdOfNode(pick.pickedMesh) : null;
          if (!groupId) return;
          camera.detachControl(); // a câmera não orbita enquanto gira a peça
          this.start({ kind: "pointer", groupId, lastAngle: this.rayAngle(groupId), pointerId: ev.pointerId });
          canvas.style.cursor = "grabbing";
        } else if (pi.type === PointerEventTypes.POINTERMOVE) {
          if (this.grab?.kind !== "pointer") return;
          this.feed(this.rayAngle(this.grab.groupId));
        } else if (pi.type === PointerEventTypes.POINTERUP) {
          if (this.grab?.kind !== "pointer") return;
          this.end();
          canvas.style.cursor = "";
          camera.attachControl(true);
        }
      },
      undefined,
      true, // insertFirst: decide antes da câmera
    );
  }

  /** VR: grip pressionado. Retorna true se agarrou alguma peça (perto da mão). */
  tryGrabXR(controller: WebXRInputSource): boolean {
    if (this.grab) return false;
    const p = handPosition(controller);
    const groupId = this.anim.groupNearPoint(p, HAND_DRIVE.grabDistance);
    if (!groupId) return false;
    this.start({ kind: "xr", groupId, lastAngle: this.anim.handAngle(groupId, p), controller });
    controller.motionController?.pulse(0.4, 40);
    return true;
  }

  /** VR: grip solto. */
  releaseXR(controller: WebXRInputSource): void {
    if (this.isGrabbedBy(controller)) this.end();
  }

  /** Solta o que estiver agarrado (reset, motor ligado, saída do VR...). */
  end(): void {
    if (!this.grab) return;
    this.grab = null;
    this.pendingDPhi = 0;
    this.drill.endHandDrive();
    this.listeners.forEach((cb) => cb(false));
  }

  /** Chamado a cada quadro: lê o controle VR e converte o giro em RPM. */
  update(dt: number): void {
    const g = this.grab;
    if (!g) return;
    if (g.kind === "xr") this.feed(this.anim.handAngle(g.groupId, handPosition(g.controller)));
    if (dt <= 0) return;

    const raw = MandrelAnimation.dPhiToSignedRPM(this.pendingDPhi, dt);
    this.pendingDPhi = 0;
    const a = 1 - Math.exp(-dt / HAND_DRIVE.smoothing);
    this.smoothedRPM += (raw - this.smoothedRPM) * a;
    if (Math.abs(this.smoothedRPM) < 1) this.smoothedRPM = 0;
    this.drill.setHandSpeed(this.smoothedRPM);
  }

  // ---------------------------------------------------------------------

  private start(grab: Grab): void {
    this.grab = grab;
    this.pendingDPhi = 0;
    this.hapticAccum = 0;
    // Continua da velocidade atual (ex.: pegou a manivela ainda girando).
    this.smoothedRPM = this.drill.signedRPM;
    this.drill.beginHandDrive();
    this.listeners.forEach((cb) => cb(true));
  }

  /** Novo ângulo da mão → gira o trem pela diferença em relação ao anterior. */
  private feed(angle: number | null): void {
    const g = this.grab;
    if (!g || angle === null) return;
    if (g.lastAngle === null) {
      g.lastAngle = angle;
      return;
    }
    let d = angle - g.lastAngle;
    if (d > Math.PI) d -= TWO_PI; // atravessou ±180°
    else if (d < -Math.PI) d += TWO_PI;
    g.lastAngle = angle;
    if (d === 0) return;
    this.pendingDPhi += this.anim.driveBy(g.groupId, d);

    if (g.kind === "xr" && HAND_DRIVE.hapticEveryTurn > 0) {
      this.hapticAccum += Math.abs(d) / TWO_PI;
      if (this.hapticAccum >= HAND_DRIVE.hapticEveryTurn) {
        this.hapticAccum = 0;
        g.controller.motionController?.pulse(0.15, 12);
      }
    }
  }

  private rayAngle(groupId: string): number | null {
    const ray = this.scene.createPickingRay(this.scene.pointerX, this.scene.pointerY, null, this.scene.activeCamera);
    return this.anim.handAngleFromRay(groupId, ray.origin, ray.direction);
  }
}

function handPosition(c: WebXRInputSource): Vector3 {
  return (c.grip ?? c.pointer).getAbsolutePosition();
}

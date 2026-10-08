import { type AbstractMesh, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { MODEL, SCENE } from "./config";
import { refreshWorld, worldBoundsOf } from "./modelLoader";

const DEG = Math.PI / 180;

/**
 * Hierarquia de posicionamento (nada disso altera a geometria do GLB):
 *
 *   furadeira_posicao   ← onde a furadeira está no mundo + giro do usuário (yaw)
 *   └─ furadeira_correcao  ← correção de orientação (MODEL.rotationDeg) e centralização
 *      └─ furadeira_vibracao  ← pequenas oscilações quando ligada
 *         └─ __root__ (GLB)
 */
export class DrillPlacement {
  readonly placementNode: TransformNode;
  readonly correctionNode: TransformNode;
  readonly vibrationNode: TransformNode;

  private homePosition = Vector3.Zero();
  private target: Vector3 | null = null;
  private inspecting = false;
  /** Elevação extra sobre a bancada (para peças que giram não tocarem nela). */
  private lift = 0;

  constructor(
    scene: Scene,
    private readonly tableTopY: number,
  ) {
    this.placementNode = new TransformNode("furadeira_posicao", scene);
    this.correctionNode = new TransformNode("furadeira_correcao", scene);
    this.vibrationNode = new TransformNode("furadeira_vibracao", scene);
    this.correctionNode.parent = this.placementNode;
    this.vibrationNode.parent = this.correctionNode;
  }

  /** Acopla o modelo carregado e o posiciona sobre a bancada. */
  attach(root: AbstractMesh): void {
    root.parent = this.vibrationNode;
    root.scaling.scaleInPlace(MODEL.scale);
    const r = MODEL.rotationDeg;
    this.applyOrientation(r.x, r.y, r.z);
  }

  /** Aplica correção de orientação, recentraliza e apoia na bancada. */
  applyOrientation(xDeg: number, yDeg: number, zDeg: number): void {
    const p = this.placementNode;
    const savedYaw = p.rotation.y;
    const savedPos = p.position.clone();
    p.position.setAll(0);
    p.rotation.y = 0;
    this.correctionNode.position.setAll(0);
    this.correctionNode.rotation.set(xDeg * DEG, yDeg * DEG, zDeg * DEG);
    refreshWorld(p);

    const box = worldBoundsOf([this.vibrationNode]);
    if (!box) return;
    const c = box.min.add(box.max).scale(0.5);
    this.correctionNode.position.copyFrom(c.negate()); // origem = centro do modelo
    const halfHeight = (box.max.y - box.min.y) / 2;

    this.homePosition = new Vector3(SCENE.drillPosition.x, this.tableTopY + halfHeight + 0.002 + this.lift, SCENE.drillPosition.z);
    p.position.copyFrom(this.inspecting ? savedPos : this.homePosition);
    p.rotation.y = savedYaw;
    refreshWorld(p);
  }

  /**
   * Eleva a furadeira em `dy` metros acima da posição apoiada (ex.: para a
   * manivela girar sem tocar na bancada). Não altera a geometria.
   */
  setLift(dy: number): void {
    const delta = dy - this.lift;
    this.lift = dy;
    this.homePosition.y += delta;
    if (!this.inspecting) {
      this.placementNode.position.y += delta;
      if (this.target) this.target.y += delta;
    }
    refreshWorld(this.placementNode);
  }

  get size(): Vector3 {
    const box = worldBoundsOf([this.vibrationNode]);
    return box ? box.max.subtract(box.min) : new Vector3(0.4, 0.2, 0.2);
  }

  get isInspecting(): boolean {
    return this.inspecting;
  }

  get isAnimating(): boolean {
    return this.target !== null;
  }

  /** Gira a furadeira em torno do eixo vertical (thumbstick no VR). */
  rotateYaw(deltaRad: number): void {
    this.placementNode.rotation.y += deltaRad;
  }

  /**
   * Modo inspeção (VR): traz a furadeira para que o mandril fique a
   * `SCENE.inspectDistance` à frente dos olhos, um pouco abaixo da linha de visão.
   */
  inspect(headPos: Vector3, headForward: Vector3, chuckWorld: Vector3): void {
    const fwd = new Vector3(headForward.x, 0, headForward.z);
    if (fwd.lengthSquared() < 1e-6) fwd.set(0, 0, 1);
    fwd.normalize();
    const desired = headPos.add(fwd.scale(SCENE.inspectDistance)).add(new Vector3(0, -0.08, 0));
    const offset = chuckWorld.subtract(this.placementNode.position);
    this.target = desired.subtract(offset);
    this.inspecting = true;
  }

  goHome(): void {
    this.target = this.homePosition.clone();
    this.inspecting = false;
  }

  /** Desloca a posição de repouso (e a atual) — usado ao entrar/sair da RA. */
  shiftHome(delta: Vector3): void {
    this.homePosition.addInPlace(delta);
    this.placementNode.position.addInPlace(delta);
    this.target?.addInPlace(delta);
    refreshWorld(this.placementNode);
  }

  /** Reposiciona imediatamente (reset). */
  resetPose(): void {
    this.target = null;
    this.inspecting = false;
    this.placementNode.position.copyFrom(this.homePosition);
    this.placementNode.rotation.y = 0;
  }

  /** Movimento suave (exponencial, independente da taxa de quadros). */
  update(dt: number): void {
    if (!this.target) return;
    const p = this.placementNode.position;
    const k = 1 - Math.exp(-dt * 8);
    Vector3.LerpToRef(p, this.target, k, p);
    if (Vector3.DistanceSquared(p, this.target) < 1e-8) {
      p.copyFrom(this.target);
      this.target = null;
    }
  }
}

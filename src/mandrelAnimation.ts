import {
  AbstractMesh,
  Color3,
  DynamicTexture,
  Matrix,
  MeshBuilder,
  Node,
  PBRMaterial,
  Quaternion,
  Scene,
  TransformNode,
  Vector3,
  VertexBuffer,
} from "@babylonjs/core";
import { BIT, CHUCK, DRILL, GEAR_TRAIN, type RotatingGroupConfig } from "./config";
import { rpmToRadPerSec } from "./drillController";
import { type LoadedModel, refreshWorld, worldBoundsOf } from "./modelLoader";

const TWO_PI = Math.PI * 2;

interface GroupRuntime {
  cfg: RotatingGroupConfig;
  nodes: TransformNode[];
  /** Nó criado em código, posicionado sobre o eixo; as peças viram filhas dele. */
  pivot: TransformNode;
  /** Eixo no espaço local do pivô (= espaço do pai original das peças). */
  axisLocal: Vector3;
  /** Eixo no mundo, medido na pose original (usado pela vista explodida). */
  axisWorld: Vector3;
  /** Converte o ângulo "mundo em torno da ponta" no ângulo local deste grupo. */
  k: number;
  angle: number;
}

/** Informações de um grupo girante, expostas para outros módulos. */
export interface RotatingGroupInfo {
  id: string;
  pivot: TransformNode;
  nodes: TransformNode[];
  axisWorld: Vector3;
}

export interface MandrelSetupReport {
  ok: boolean;
  missing: string[];
  groups: string[];
}

/**
 * Animação do mandril (e, opcionalmente, do trem de engrenagens).
 *
 * Técnica: para cada grupo é criado um TransformNode "pivô" exatamente sobre
 * o eixo de rotação; as peças do GLB são re-parenteadas a ele com
 * `setParent` (que preserva a posição no mundo — a geometria NÃO é alterada).
 * A cada quadro só o quaternion do pivô muda, então a rotação é independente
 * da câmera e de qualquer movimento/vibração aplicado à furadeira inteira.
 */
export class MandrelAnimation {
  /** Multiplicador da velocidade exibida (anti-estroboscópico). 1 = físico. */
  speedFactor = 1;
  /** Direção do eixo do mandril apontando para a ponta da broca (mundo). */
  tipDirection = new Vector3(1, 0, 0);
  bitMeshes: AbstractMesh[] = [];

  private groups: GroupRuntime[] = [];
  private chuck: GroupRuntime | null = null;

  constructor(
    private readonly scene: Scene,
    private readonly model: LoadedModel,
  ) {}

  setup(): MandrelSetupReport {
    refreshWorld(this.model.root);
    const missing: string[] = [];
    const find = (name: string): TransformNode | undefined => {
      const n = this.model.nodesByName.get(name);
      if (!n) missing.push(name);
      return n;
    };

    // ---- Mandril (obrigatório) -------------------------------------------
    const chuckNodes = CHUCK.nodes.map(find).filter((n): n is TransformNode => !!n);
    const chuckAxisNode = find(CHUCK.axisNode);
    if (!chuckAxisNode || chuckNodes.length === 0) {
      return { ok: false, missing, groups: [] };
    }

    // Sentido da ponta: do centro da furadeira para o centro do mandril.
    const axisW = axisWorld(CHUCK, chuckAxisNode);
    const chuckBox = worldBoundsOf(chuckNodes);
    const modelBox = worldBoundsOf([this.model.root]);
    let tipSign = 1;
    if (chuckBox && modelBox) {
      const toTip = center(chuckBox).subtract(center(modelBox));
      tipSign = Vector3.Dot(axisW, toTip) < 0 ? -1 : 1;
    }
    this.tipDirection = axisW.scale(tipSign);

    this.chuck = this.createGroup(CHUCK, chuckNodes, chuckAxisNode, tipSign);
    this.groups.push(this.chuck);

    // ---- Trem de engrenagens (opcional) -----------------------------------
    if (GEAR_TRAIN.enabled) {
      for (const cfg of GEAR_TRAIN.groups) {
        const nodes = cfg.nodes.map(find).filter((n): n is TransformNode => !!n);
        const axisNode = find(cfg.axisNode);
        if (!axisNode || nodes.length === 0) continue;
        this.groups.push(this.createGroup(cfg, nodes, axisNode, tipSign));
      }
    }

    if (BIT.enabled) this.createBit(this.chuck);

    return { ok: true, missing, groups: this.groups.map((g) => g.cfg.id) };
  }

  /**
   * Avança a rotação. `signedRPM` > 0 = sentido 1 (horário).
   * Δθ = ω·dt, com ω = RPM·2π/60 — independente da taxa de quadros.
   */
  update(dt: number, signedRPM: number, speedFactor = this.speedFactor): void {
    if (signedRPM === 0 || this.groups.length === 0) return;
    this.advance(rpmToDPhi(signedRPM, dt) * speedFactor);
  }

  // ------------------------------------------------ acionamento manual ----

  /** Id do grupo girante que contém este nó (malha clicada), ou null. */
  groupIdOfNode(node: Node | null): string | null {
    for (let n = node; n; n = n.parent) {
      const g = this.groups.find((x) => x.pivot === n);
      if (g) return g.cfg.id;
    }
    return null;
  }

  /** Grupo cuja peça está mais perto do ponto (mundo), até `maxDist` metros. */
  groupNearPoint(p: Vector3, maxDist: number): string | null {
    let best: string | null = null;
    let bestD = maxDist;
    for (const g of this.groups) {
      for (const m of g.pivot.getChildMeshes(false)) {
        if (m.getTotalVertices() === 0 || !m.isEnabled()) continue;
        const b = m.getBoundingInfo().boundingBox;
        const d = distanceToBox(p, b.minimumWorld, b.maximumWorld);
        if (d < bestD) {
          bestD = d;
          best = g.cfg.id;
        }
      }
    }
    return best;
  }

  /** Ângulo (local, rad) de um ponto do mundo em torno do eixo do grupo; null se muito perto do eixo. */
  handAngle(groupId: string, pointWorld: Vector3): number | null {
    const g = this.group(groupId);
    if (!g) return null;
    const inv = this.parentInverse(g);
    return planeAngle(g, Vector3.TransformCoordinates(pointWorld, inv));
  }

  /** Igual a handAngle, mas a partir de um raio (mouse/toque) cortando o plano da peça. */
  handAngleFromRay(groupId: string, origin: Vector3, direction: Vector3): number | null {
    const g = this.group(groupId);
    if (!g) return null;
    const inv = this.parentInverse(g);
    const o = Vector3.TransformCoordinates(origin, inv);
    const d = Vector3.TransformNormal(direction, inv).normalize();
    const denom = Vector3.Dot(d, g.axisLocal);
    if (Math.abs(denom) < 0.08) return null; // plano visto de lado
    const t = Vector3.Dot(g.pivot.position.subtract(o), g.axisLocal) / denom;
    if (t < 0) return null;
    return planeAngle(g, o.add(d.scale(t)));
  }

  /**
   * Gira o grupo `groupId` em `dLocal` rad e todo o trem junto, nas relações
   * reais. Retorna o Δ equivalente do mandril (para calcular o RPM).
   */
  driveBy(groupId: string, dLocal: number): number {
    const g = this.group(groupId);
    if (!g || g.k === 0) return 0;
    const dPhi = dLocal / g.k;
    this.advance(dPhi);
    return dPhi;
  }

  /** Converte o Δ do mandril num intervalo em RPM com sinal (+ = sentido 1). */
  static dPhiToSignedRPM(dPhi: number, dt: number): number {
    return dt > 0 ? dPhi / rpmToDPhi(1, dt) : 0;
  }

  /** Relação |rotação do grupo / rotação do mandril| (manivela ≈ 0,061). */
  ratioOf(groupId: string): number {
    return Math.abs(this.group(groupId)?.cfg.ratio ?? 1);
  }

  private advance(dPhi: number): void {
    for (const g of this.groups) {
      g.angle = (g.angle + g.k * dPhi) % TWO_PI;
      Quaternion.RotationAxisToRef(g.axisLocal, g.angle, g.pivot.rotationQuaternion!);
    }
  }

  private group(id: string): GroupRuntime | undefined {
    return this.groups.find((g) => g.cfg.id === id);
  }

  private parentInverse(g: GroupRuntime): Matrix {
    const parent = g.pivot.parent;
    if (!parent) return Matrix.Identity();
    parent.computeWorldMatrix(true);
    return Matrix.Invert(parent.getWorldMatrix());
  }

  /** Volta todas as peças à posição original do CAD. */
  resetPose(): void {
    for (const g of this.groups) {
      g.angle = 0;
      g.pivot.rotationQuaternion!.copyFromFloats(0, 0, 0, 1);
    }
  }

  /** Centro do mandril no mundo (para focar a câmera / modo inspeção). */
  chuckWorldCenter(): Vector3 | null {
    if (!this.chuck) return null;
    refreshWorld(this.chuck.pivot);
    const box = worldBoundsOf(this.chuck.nodes);
    return box ? center(box) : this.chuck.pivot.getAbsolutePosition().clone();
  }

  get isReady(): boolean {
    return this.chuck !== null;
  }

  /**
   * Ponto mais baixo (Y do mundo) que as peças girantes alcançam numa volta
   * completa — ex.: o punho da manivela passando por baixo. Para cada grupo:
   * raio = maior distância de um canto das peças ao eixo; numa volta, o ponto
   * mais baixo do círculo fica R·√(1 − a_y²) abaixo do eixo.
   */
  lowestSweepY(): number | null {
    let lowest: number | null = null;
    for (const g of this.groups) {
      refreshWorld(g.pivot);
      const origin = g.pivot.getAbsolutePosition();
      const parent = g.pivot.parent;
      const axis = parent
        ? Vector3.TransformNormal(g.axisLocal, parent.getWorldMatrix()).normalize()
        : g.axisLocal.clone().normalize();
      // Exato por vértice: cada ponto descreve seu próprio círculo em torno do
      // eixo; o ponto mais baixo desse círculo é (y do centro) − r·√(1 − a_y²).
      const k = Math.sqrt(Math.max(0, 1 - axis.y * axis.y));
      let groupLowest = Infinity;
      const v = new Vector3();
      for (const m of g.pivot.getChildMeshes(false)) {
        const pos = m.getVerticesData(VertexBuffer.PositionKind);
        if (!pos || pos.length === 0) continue;
        const world = m.computeWorldMatrix(true);
        for (let i = 0; i < pos.length; i += 3) {
          Vector3.TransformCoordinatesFromFloatsToRef(pos[i], pos[i + 1], pos[i + 2], world, v);
          v.subtractInPlace(origin);
          const t = Vector3.Dot(v, axis);
          const dx = v.x - axis.x * t;
          const dy = v.y - axis.y * t;
          const dz = v.z - axis.z * t;
          const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
          groupLowest = Math.min(groupLowest, origin.y + axis.y * t - r * k);
        }
      }
      if (!Number.isFinite(groupLowest)) continue;
      lowest = lowest === null ? groupLowest : Math.min(lowest, groupLowest);
    }
    return lowest;
  }

  /** Grupos girantes (pivô, peças e eixo), na ordem: mandril primeiro. */
  rotatingGroups(): RotatingGroupInfo[] {
    return this.groups.map((g) => ({ id: g.cfg.id, pivot: g.pivot, nodes: g.nodes, axisWorld: g.axisWorld }));
  }

  // ---------------------------------------------------------------------

  private createGroup(
    cfg: RotatingGroupConfig,
    nodes: TransformNode[],
    axisNode: TransformNode,
    tipSign: number,
  ): GroupRuntime {
    const axisW = axisWorld(cfg, axisNode);
    let pivotW: Vector3;
    if (cfg.pivotLocal) {
      pivotW = Vector3.TransformCoordinates(Vector3.FromArray(cfg.pivotLocal), axisNode.getWorldMatrix());
    } else {
      const box = worldBoundsOf([axisNode]);
      pivotW = box ? center(box) : axisNode.getAbsolutePosition().clone();
    }

    // O pivô fica sob o MESMO pai das peças, evitando decompor matrizes com
    // espelhamento (o "__root__" do glTF tem escala z = −1).
    const parent: Node | null = nodes[0].parent;
    const parentWorld = parent ? parent.getWorldMatrix() : Matrix.IdentityReadOnly;
    const inv = Matrix.Invert(parentWorld);

    const pivot = new TransformNode(`pivo_${cfg.id}`, this.scene);
    pivot.parent = parent;
    pivot.position = Vector3.TransformCoordinates(pivotW, inv);
    pivot.rotationQuaternion = Quaternion.Identity();
    pivot.computeWorldMatrix(true);
    for (const n of nodes) n.setParent(pivot);

    const axisLocal = Vector3.TransformNormal(axisW, inv).normalize();
    // Se o pai espelha o espaço, uma rotação local positiva aparece negativa no mundo.
    const det = parentWorld.determinant() < 0 ? -1 : 1;
    // Ângulo mundo em torno do eixo do grupo = ratio × ângulo mundo em torno
    // do eixo de referência do mandril (= tipSign × ângulo em torno da ponta).
    const k = cfg.ratio * tipSign * det;

    console.info(
      `[mandril] grupo "${cfg.id}": ${nodes.length} nó(s), eixo mundo (${fmt(axisW)}), ` +
        `pivô mundo (${fmt(pivotW)}), relação ${cfg.ratio.toFixed(4)}`,
    );
    return { cfg, nodes, pivot, axisLocal, axisWorld: axisW, k, angle: 0 };
  }

  /** Broca procedural presa ao pivô do mandril (o GLB não tem broca). */
  private createBit(chuck: GroupRuntime): void {
    refreshWorld(chuck.pivot);
    const pivotW = chuck.pivot.getAbsolutePosition().clone();
    const dir = this.tipDirection;

    // Ponto mais avançado das castanhas ao longo do eixo.
    let tMax = 0;
    for (const n of chuck.nodes) {
      const meshes = n instanceof AbstractMesh ? [n, ...n.getChildMeshes(false)] : n.getChildMeshes(false);
      for (const m of meshes) {
        if (m.getTotalVertices() === 0) continue;
        for (const v of m.getBoundingInfo().boundingBox.vectorsWorld) {
          tMax = Math.max(tMax, Vector3.Dot(v.subtract(pivotW), dir));
        }
      }
    }

    const startW = pivotW.add(dir.scale(tMax - BIT.insertion));
    const endW = startW.add(dir.scale(BIT.length));
    const inv = Matrix.Invert(chuck.pivot.getWorldMatrix());
    const startL = Vector3.TransformCoordinates(startW, inv);
    const endL = Vector3.TransformCoordinates(endW, inv);
    const lenL = Vector3.Distance(startL, endL);

    const root = new TransformNode("broca_procedural", this.scene);
    root.parent = chuck.pivot;
    root.position = startL;
    root.rotationQuaternion = new Quaternion();
    Quaternion.FromUnitVectorsToRef(Vector3.Up(), endL.subtract(startL).normalize(), root.rotationQuaternion);
    root.scaling.setAll(lenL / BIT.length);

    const tipLen = BIT.diameter * 0.9;
    const body = MeshBuilder.CreateCylinder(
      "broca_corpo",
      { height: BIT.length - tipLen, diameter: BIT.diameter, tessellation: 20 },
      this.scene,
    );
    body.parent = root;
    body.position.y = (BIT.length - tipLen) / 2;

    const tip = MeshBuilder.CreateCylinder(
      "broca_ponta",
      { height: tipLen, diameterTop: 0, diameterBottom: BIT.diameter, tessellation: 20 },
      this.scene,
    );
    tip.parent = root;
    tip.position.y = BIT.length - tipLen / 2;

    const mat = new PBRMaterial("broca_mat", this.scene);
    mat.albedoColor = new Color3(0.8, 0.82, 0.85);
    mat.metallic = 1;
    mat.roughness = 0.35;
    mat.albedoTexture = makeFluteTexture(this.scene);
    body.material = mat;
    tip.material = mat;

    this.bitMeshes = [body, tip];
    for (const m of this.bitMeshes) m.isPickable = false;
  }
}

/** Pequena vibração no corpo da ferramenta, proporcional ao RPM. */
export class VibrationEffect {
  private t = 0;
  constructor(private readonly node: TransformNode) {}

  update(dt: number, intensity: number, amplitude: number): void {
    const p = this.node.position;
    if (intensity <= 0 || amplitude <= 0) {
      if (p.x !== 0 || p.y !== 0 || p.z !== 0) p.setAll(0);
      return;
    }
    this.t += dt;
    const a = amplitude * Math.min(1, intensity);
    const t = this.t * TWO_PI;
    p.set(a * Math.sin(t * 27.3), 0.6 * a * Math.sin(t * 31.7 + 1.3), a * Math.sin(t * 23.9 + 2.1));
  }
}

// ---------------------------------------------------------------- utilidades

function axisWorld(cfg: RotatingGroupConfig, axisNode: TransformNode): Vector3 {
  axisNode.computeWorldMatrix(true);
  return Vector3.TransformNormal(Vector3.FromArray(cfg.axisLocal), axisNode.getWorldMatrix()).normalize();
}

/**
 * Δ do ângulo de referência do mandril para `signedRPM` em `dt` segundos.
 * Babylon usa sistema de mão esquerda: olhando AO LONGO do eixo (+tip),
 * ângulo positivo = anti-horário. Logo horário visto por trás = negativo.
 */
function rpmToDPhi(signedRPM: number, dt: number): number {
  const viewSign = DRILL.clockwiseViewedFrom === "behind" ? 1 : -1;
  return -viewSign * rpmToRadPerSec(signedRPM) * dt;
}

/**
 * Ângulo de um ponto (espaço do pai do pivô) em torno do eixo do grupo.
 * A base (u, v) é construída girando u +90° com o MESMO quaternion usado na
 * animação, então "+Δ medido" = "+Δ aplicado" em qualquer sistema de mãos.
 */
function planeAngle(g: GroupRuntime, pLocal: Vector3): number | null {
  const a = g.axisLocal;
  const r = pLocal.subtract(g.pivot.position);
  r.subtractInPlace(a.scale(Vector3.Dot(r, a)));
  if (r.length() < 0.004) return null; // perto demais do eixo: ângulo instável
  const ref = Math.abs(a.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  const u = ref.subtract(a.scale(Vector3.Dot(ref, a))).normalize();
  const v = u.applyRotationQuaternion(Quaternion.RotationAxis(a, Math.PI / 2));
  return Math.atan2(Vector3.Dot(r, v), Vector3.Dot(r, u));
}

function distanceToBox(p: Vector3, min: Vector3, max: Vector3): number {
  const dx = Math.max(min.x - p.x, 0, p.x - max.x);
  const dy = Math.max(min.y - p.y, 0, p.y - max.y);
  const dz = Math.max(min.z - p.z, 0, p.z - max.z);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function center(box: { min: Vector3; max: Vector3 }): Vector3 {
  return box.min.add(box.max).scale(0.5);
}

function fmt(v: Vector3): string {
  return `${v.x.toFixed(4)}, ${v.y.toFixed(4)}, ${v.z.toFixed(4)}`;
}

/** Duas faixas helicoidais escuras: tornam a rotação da broca visível. */
function makeFluteTexture(scene: Scene): DynamicTexture {
  const size = 256;
  const tex = new DynamicTexture("broca_tex", { width: size, height: size }, scene, true);
  const ctx = tex.getContext();
  ctx.fillStyle = "#c9cdd2";
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "#3a3f45";
  ctx.lineWidth = 38;
  for (const offset of [-size, -size / 2, 0, size / 2, size]) {
    ctx.beginPath();
    ctx.moveTo(offset, 0);
    ctx.lineTo(offset + size, size);
    ctx.stroke();
  }
  tex.update();
  tex.vScale = 3;
  return tex;
}

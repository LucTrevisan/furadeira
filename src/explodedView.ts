import { Matrix, type Node, TransformNode, Vector3 } from "@babylonjs/core";
import { EXPLODE } from "./config";
import type { MandrelAnimation, RotatingGroupInfo } from "./mandrelAnimation";
import { type LoadedModel, refreshWorld, worldBoundsOf } from "./modelLoader";

interface Unit {
  node: TransformNode;
  /** Posição local original (montada). */
  base: Vector3;
  /** Deslocamento local com a vista totalmente explodida (fator 1). */
  offset: Vector3;
}

/**
 * Vista explodida: cada peça recebe um deslocamento calculado uma única vez,
 * na pose original, e a posição local é interpolada entre montada (0) e
 * explodida (1). A geometria do GLB não é alterada.
 *
 * Os deslocamentos ficam no espaço LOCAL do pai de cada peça. Assim:
 *  - a furadeira pode ser girada/movida (modo aproximar, thumbstick) explodida;
 *  - peças dentro de um grupo girante se afastam ao longo do eixo do grupo,
 *    que é constante no espaço do pivô → continuam girando no eixo certo.
 */
export class ExplodedView {
  private units: Unit[] = [];
  private current = 0;
  private from = 0;
  private to = 0;
  private t = 1;
  private readonly listeners = new Set<(factor: number) => void>();

  constructor(
    private readonly model: LoadedModel,
    private readonly anim: MandrelAnimation | null,
  ) {}

  /** Deve ser chamado com a furadeira montada e parada (logo após carregar). */
  setup(): number {
    const root = this.model.root;
    refreshWorld(root);
    const box = worldBoundsOf([root]);
    if (!box) return 0;
    const center = box.min.add(box.max).scale(0.5);
    // Eixo mais comprido da montagem (no mundo): as demais direções são reforçadas.
    const size = box.max.subtract(box.min);
    const longAxis =
      size.x >= size.y && size.x >= size.z ? new Vector3(1, 0, 0) : size.y >= size.z ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1);
    const radial = (c: Vector3): Vector3 => radialOffset(c, center, longAxis);

    const groups = this.anim?.rotatingGroups() ?? [];
    const groupByPivot = new Map<Node, RotatingGroupInfo>(groups.map((g) => [g.pivot, g]));

    // "Peça" = nó do GLB que carrega geometria. Malhas com vários materiais
    // viram NOME_primitive0, NOME_primitive1… sob um nó NOME: a peça é o pai.
    const parts = new Set<TransformNode>();
    for (const m of root.getChildMeshes(false)) {
      if (m.getTotalVertices() === 0) continue;
      const usesParent = /_primitive\d+$/.test(m.name) || m.parent?.name === "broca_procedural";
      parts.add(usesParent && m.parent instanceof TransformNode ? m.parent : m);
    }

    for (const part of parts) {
      const c = centerOf(part);
      if (!c) continue;
      const group = findGroup(part, groupByPivot);
      if (group) {
        const pivotW = group.pivot.getAbsolutePosition();
        const along = Vector3.Dot(c.subtract(pivotW), group.axisWorld);
        this.addUnit(part, group.axisWorld.scale(along * EXPLODE.axialSpread));
      } else {
        this.addUnit(part, radial(c));
      }
    }
    for (const g of groups) {
      const gb = worldBoundsOf(g.nodes);
      const gc = gb ? gb.min.add(gb.max).scale(0.5) : g.pivot.getAbsolutePosition();
      this.addUnit(g.pivot, radial(gc));
    }
    console.info(`[explosão] ${this.units.length} peças/grupos preparados.`);
    return this.units.length;
  }

  get factor(): number {
    return this.current;
  }

  get isAnimating(): boolean {
    return this.t < 1;
  }

  get isReady(): boolean {
    return this.units.length > 0;
  }

  /** Define o fator imediatamente (slider, thumbstick). 0 = montada, 1 = explodida. */
  setFactor(f: number): void {
    this.t = 1;
    this.apply(clamp01(f));
  }

  /** Anima suavemente até o fator desejado. */
  animateTo(f: number): void {
    this.from = this.current;
    this.to = clamp01(f);
    this.t = this.from === this.to ? 1 : 0;
  }

  /** Explode se estiver (quase) montada; monta caso contrário. */
  toggle(): void {
    this.animateTo(this.current > 0.5 ? 0 : 1);
  }

  onChange(cb: (factor: number) => void): void {
    this.listeners.add(cb);
  }

  update(dt: number): void {
    if (this.t >= 1) return;
    this.t = Math.min(1, this.t + dt / EXPLODE.duration);
    const e = this.t < 0.5 ? 4 * this.t ** 3 : 1 - (-2 * this.t + 2) ** 3 / 2; // easeInOutCubic
    this.apply(this.from + (this.to - this.from) * e);
  }

  private apply(f: number): void {
    if (f === this.current && this.units.length) return;
    this.current = f;
    for (const u of this.units) {
      u.node.position.copyFrom(u.base);
      u.offset.scaleAndAddToRef(f, u.node.position);
    }
    this.listeners.forEach((cb) => cb(f));
  }

  private addUnit(node: TransformNode, offsetWorld: Vector3): void {
    const parent = node.parent;
    const inv = parent ? Matrix.Invert(parent.getWorldMatrix()) : Matrix.Identity();
    this.units.push({
      node,
      base: node.position.clone(),
      offset: Vector3.TransformNormal(offsetWorld, inv),
    });
  }
}

function radialOffset(c: Vector3, center: Vector3, longAxis: Vector3): Vector3 {
  const v = c.subtract(center);
  // Componente ao longo do comprimento mantém-se; as transversais são reforçadas.
  const along = longAxis.scale(Vector3.Dot(v, longAxis));
  const cross = v.subtract(along).scale(EXPLODE.crossBoost);
  const w = along.add(cross);
  w.y = Math.abs(w.y); // nunca afunda na bancada: o que iria para baixo sobe
  const len = w.length();
  const dir = len > 1e-6 ? w.scale(1 / len) : new Vector3(0, 1, 0);
  return w.scale(EXPLODE.spread).add(dir.scale(EXPLODE.minDistance));
}

function centerOf(node: TransformNode): Vector3 | null {
  const b = worldBoundsOf([node]);
  return b ? b.min.add(b.max).scale(0.5) : null;
}

/** Primeiro pivô girante entre os ancestrais da peça (ou null se for fixa). */
function findGroup(node: Node, groups: Map<Node, RotatingGroupInfo>): RotatingGroupInfo | null {
  for (let p = node.parent; p; p = p.parent) {
    const g = groups.get(p);
    if (g) return g;
  }
  return null;
}

function clamp01(f: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(f) ? f : 0));
}

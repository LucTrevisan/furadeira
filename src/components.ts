import {
  AbstractMesh,
  Color3,
  type Node,
  PointerEventTypes,
  type Scene,
  Matrix,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { AdvancedDynamicTexture, Control, Line, Rectangle, TextBlock } from "@babylonjs/gui";
import type { LoadedModel } from "./modelLoader";
import { worldBoundsOf } from "./modelLoader";

/**
 * Catálogo educacional. Somente componentes PRESENTES no GLB: cada entrada
 * casa com nomes reais de nós (o primeiro ancestral que casar vence, então
 * entradas específicas — castanhas — vêm antes das genéricas — mandril).
 */
export interface ComponentInfo {
  id: string;
  name: string;
  role: string;
  description: string;
  match: RegExp;
}

export const COMPONENTS: ComponentInfo[] = [
  {
    id: "castanhas",
    name: "Castanhas do mandril",
    role: "Prender e centralizar a ferramenta.",
    description: "Três garras guiadas pelo cone de ajuste. Ao apertar a capa do mandril, elas se fecham sobre a haste da broca.",
    match: /castanha/i,
  },
  {
    id: "cone",
    name: "Cone de ajuste e molas",
    role: "Guiar a abertura e o fechamento das castanhas.",
    description: "As molas mantêm as castanhas abertas; o cone as empurra para o centro durante o aperto.",
    match: /CONE DE AJUSTE|MOLA/i,
  },
  {
    id: "mandril",
    name: "Mandril",
    role: "Fixação da broca ou ferramenta de corte.",
    description: "Conjunto de corpo roscado, capa e castanhas. Gira com o eixo-árvore e transmite o torque à ferramenta.",
    match: /MONTAGEM MANDRIL|CORPO ROSCADO|CAPA DO MANDRIL/i,
  },
  {
    id: "broca",
    name: "Broca (representação)",
    role: "Ferramenta de corte.",
    description: "Não faz parte do modelo CAD: foi adicionada pela simulação para tornar a rotação do mandril visível.",
    match: /^broca_/i,
  },
  {
    id: "eixo-arvore",
    name: "Eixo-árvore",
    role: "Transmitir a rotação ao mandril.",
    description: "Eixo principal, coaxial ao mandril. Recebe o movimento do pinhão Z15.",
    match: /EIXO DO MANDRIL/i,
  },
  {
    id: "pinhao",
    name: "Pinhão Z15",
    role: "Receber o movimento da coroa e acionar o eixo-árvore.",
    description: "Engrena na coroa Z30: relação 30/15, o mandril gira 2× mais rápido que a coroa.",
    match: /PINHAO/i,
  },
  {
    id: "coroa",
    name: "Coroa Z30",
    role: "Último estágio de transmissão até o mandril.",
    description: "Engrenagem de 30 dentes que muda a direção do movimento e o entrega ao pinhão do eixo-árvore.",
    match: /COROA/i,
  },
  {
    id: "engrenagem-z43",
    name: "Engrenagem Z43",
    role: "Multiplicar a velocidade (estágio de transmissão).",
    description: "Engrenagem de 43 dentes (módulo 1) que aciona uma engrenagem Z15: cada estágio multiplica a rotação por 43/15 ≈ 2,9.",
    match: /Z 43/i,
  },
  {
    id: "engrenagem-z15",
    name: "Engrenagem Z15",
    role: "Receber e transmitir o movimento do estágio anterior.",
    description: "Engrenagem de 15 dentes (módulo 1), solidária ao eixo intermediário.",
    match: /M1_Z15/i,
  },
  {
    id: "eixo-intermediario",
    name: "Eixo intermediário",
    role: "Suportar e sincronizar as engrenagens de um estágio.",
    description: "Une as engrenagens que giram juntas no trem de transmissão.",
    match: /EIXO DAS ENGRENAGENS/i,
  },
  {
    id: "bucha",
    name: "Bucha (mancal de bronze)",
    role: "Apoiar os eixos e reduzir o atrito.",
    description: "Mancal de deslizamento em bronze: guia o eixo na carcaça com baixo desgaste.",
    match: /BUCHA/i,
  },
  {
    id: "manivela",
    name: "Manivela",
    role: "Elemento utilizado pelo operador para o acionamento.",
    description: "Braço e punho acionam a engrenagem Z43 maior. Uma volta da manivela ≈ 16,4 voltas do mandril.",
    match: /SUBMONT MANIVELA|MANIVELA|CABO DE MANIVELA|BOTÃO DE APERTO/i,
  },
  {
    id: "carcaca",
    name: "Carcaça",
    role: "Alojar e alinhar o trem de engrenagens.",
    description: "Corpo estrutural da furadeira. Exibido transparente para revelar o mecanismo interno.",
    match: /CORPO DE ALUMINIO/i,
  },
  {
    id: "tampa",
    name: "Tampa lateral",
    role: "Fechar e proteger o mecanismo.",
    description: "Tampas da carcaça, também exibidas transparentes.",
    match: /^TAMPA-/i,
  },
  {
    id: "cabo-sustentacao",
    name: "Cabo de sustentação",
    role: "Apoio da mão do operador.",
    description: "Empunhadura lateral usada para firmar a ferramenta durante a furação.",
    match: /CABO SUST|CABO DE SUSTENTA|PARAFUSO DO CABO/i,
  },
  {
    id: "encosto",
    name: "Encosto (apoio de peito)",
    role: "Permitir aplicar força de avanço com o corpo.",
    description: "O operador apoia o peito no encosto para empurrar a broca contra a peça.",
    match: /ENCOSTO|HASTE DE APOIO/i,
  },
  {
    id: "fixacao",
    name: "Elemento de fixação",
    role: "Unir e posicionar as peças da montagem.",
    description: "Parafusos e pinos de montagem.",
    match: /screw|PINO D |PINO ROSCADO|ARRUELA|TRAVA|ANEL DO CABO/i,
  },
];

export interface ComponentHit {
  info: ComponentInfo;
  /** Nome técnico da peça no CAD. */
  partName: string;
  meshes: AbstractMesh[];
}

/** Rótulos exibidos na vista explodida (componentes principais). */
const LABELED: Array<{ id: string; node: string }> = [
  { id: "mandril", node: "MONTAGEM MANDRIL" },
  { id: "coroa", node: "COROA Z 30-1" },
  { id: "engrenagem-z43", node: "ENGREN MAIOR MOD 1  Z 43 a-1" },
  { id: "pinhao", node: "PINHAOZ 15 a-1" },
  { id: "manivela", node: "BRAÇO DA MANIVELA-1" },
  { id: "carcaca", node: "CORPO DE ALUMINIO-1" },
  { id: "encosto", node: "ENCOSTO-1" },
  { id: "cabo-sustentacao", node: "CABO DE SUSTENTAÇÃO-2" },
];

/**
 * Identificação de componentes (desktop): hover destaca e mostra um tooltip;
 * clique seleciona e publica as informações. Picking feito sob demanda e com
 * taxa limitada (a cena tem skipPointerMovePicking ligado).
 */
export class ComponentInspector {
  enabled = true;
  private hovered: ComponentHit | null = null;
  private selected: ComponentHit | null = null;
  private lastPick = 0;
  private dragging = false;
  private readonly hoverListeners = new Set<(hit: ComponentHit | null, x: number, y: number) => void>();
  private readonly selectListeners = new Set<(hit: ComponentHit | null) => void>();
  private labelsUi: AdvancedDynamicTexture | null = null;
  private labelControls: Rectangle[] = [];

  constructor(
    private readonly scene: Scene,
    private readonly model: LoadedModel,
    private readonly extraMeshes: AbstractMesh[],
    isActive: () => boolean,
    private readonly onVisualChange: () => void,
  ) {
    scene.onPointerObservable.add((pi) => {
      if (!this.enabled || !isActive()) return;
      const ev = pi.event as PointerEvent;
      if (pi.type === PointerEventTypes.POINTERDOWN) this.dragging = true;
      else if (pi.type === PointerEventTypes.POINTERUP) this.dragging = false;
      else if (pi.type === PointerEventTypes.POINTERMOVE) {
        if (this.dragging || ev.pointerType === "touch") return this.setHover(null, 0, 0);
        const now = performance.now();
        if (now - this.lastPick < 50) return;
        this.lastPick = now;
        this.setHover(this.pickAt(scene.pointerX, scene.pointerY), ev.clientX, ev.clientY);
      } else if (pi.type === PointerEventTypes.POINTERTAP) {
        const hit = this.pickAt(scene.pointerX, scene.pointerY);
        this.select(hit);
      }
    });
  }

  onHover(cb: (hit: ComponentHit | null, x: number, y: number) => void): void {
    this.hoverListeners.add(cb);
  }

  onSelect(cb: (hit: ComponentHit | null) => void): void {
    this.selectListeners.add(cb);
  }

  get selection(): ComponentHit | null {
    return this.selected;
  }

  /** Seleciona programaticamente (ou limpa com null). */
  select(hit: ComponentHit | null): void {
    this.paint(this.selected, false);
    this.selected = hit;
    this.paint(this.hovered, true, 0.18);
    this.paint(hit, true, 0.32);
    this.selectListeners.forEach((cb) => cb(hit));
    this.onVisualChange();
  }

  /** Destaca nós arbitrários (helper de console `drill.highlight`). */
  highlightNode(node: Node): void {
    const meshes = node instanceof TransformNode ? meshesOf(node) : [];
    const info = identify(node) ?? COMPONENTS[COMPONENTS.length - 1];
    this.select({ info, partName: node.name, meshes });
  }

  clear(): void {
    this.setHover(null, 0, 0);
    this.select(null);
  }

  /** Rótulos dos componentes principais, visíveis com a vista explodida. */
  setLabelsVisible(visible: boolean): void {
    if (visible && !this.labelsUi) this.createLabels();
    if (!this.labelsUi) return;
    for (const c of this.labelControls) c.isVisible = visible;
    this.labelsUi.rootContainer.isVisible = visible;
    this.onVisualChange();
  }

  // ---------------------------------------------------------------------

  private pickAt(x: number, y: number): ComponentHit | null {
    const pick = this.scene.pick(x, y, (m) => m.isPickable && m.isEnabled() && m.isVisible && m.name !== "sombra_contato");
    const mesh = pick?.hit ? pick.pickedMesh : null;
    if (!mesh || !this.isModelMesh(mesh)) return null;
    const info = identify(mesh);
    if (!info) return null;
    // Peça = maior ancestral que ainda casa com o mesmo componente.
    let part: Node = mesh;
    for (let n: Node | null = mesh; n; n = n.parent) {
      if (/^MONTAGEM MAQUINA|^__root__|^pivo_|^furadeira_/i.test(n.name)) break;
      if (info.match.test(n.name)) part = n;
    }
    const meshes = part instanceof TransformNode ? meshesOf(part) : [mesh];
    return { info, partName: part.name.replace(/_primitive\d+$/, ""), meshes };
  }

  private isModelMesh(m: AbstractMesh): boolean {
    return this.model.meshes.includes(m) || this.extraMeshes.includes(m);
  }

  private setHover(hit: ComponentHit | null, x: number, y: number): void {
    const same = hit?.partName === this.hovered?.partName;
    if (!same) {
      if (this.hovered && this.hovered.partName !== this.selected?.partName) this.paint(this.hovered, false);
      this.hovered = hit;
      if (hit && hit.partName !== this.selected?.partName) this.paint(hit, true, 0.18);
      this.onVisualChange();
    }
    this.hoverListeners.forEach((cb) => cb(hit, x, y));
  }

  /** Destaque discreto: sobreposição âmbar translúcida (sem passes extras). */
  private paint(hit: ComponentHit | null, on: boolean, alpha = 0.2): void {
    if (!hit) return;
    for (const m of hit.meshes) {
      m.renderOverlay = on;
      if (on) {
        m.overlayColor = new Color3(0.96, 0.65, 0.14);
        m.overlayAlpha = alpha;
      }
    }
  }

  private createLabels(): void {
    const ui = AdvancedDynamicTexture.CreateFullscreenUI("rotulos_componentes", true, this.scene);
    ui.isForeground = true;
    ui.rootContainer.isPointerBlocker = false;
    const engine = this.scene.getEngine();
    const k = 1 / engine.getHardwareScalingLevel(); // tamanhos em pixels CSS

    type Label = { anchor: TransformNode; tag: Rectangle; line: Line; w: number; h: number };
    const labels: Label[] = [];
    for (const l of LABELED) {
      const node = this.model.nodesByName.get(l.node);
      const info = COMPONENTS.find((c) => c.id === l.id);
      if (!node || !info) continue;
      const box = worldBoundsOf([node]);
      if (!box) continue;
      // Âncora no centro da peça, filha dela: acompanha explosão e rotação.
      const anchor = new TransformNode(`rotulo_${l.id}`, this.scene);
      anchor.parent = node;
      anchor.setAbsolutePosition(box.min.add(box.max).scale(0.5));

      const line = new Line(`linha_${l.id}`);
      line.color = "rgba(242,163,58,0.75)";
      line.lineWidth = 1.5 * k;
      line.isPointerBlocker = false;
      ui.addControl(line);

      const w = Math.round((info.name.length * 7 + 26) * k);
      const h = Math.round(24 * k);
      const tag = new Rectangle(`rotulo_${l.id}`);
      tag.width = `${w}px`;
      tag.height = `${h}px`;
      tag.cornerRadius = 4 * k;
      tag.thickness = 1 * k;
      tag.color = "rgba(242,163,58,0.85)";
      tag.background = "rgba(14,17,20,0.92)";
      tag.isPointerBlocker = false;
      tag.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
      tag.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
      const t = new TextBlock(undefined, info.name.toUpperCase());
      t.color = "#e8ecef";
      t.fontSize = 10.5 * k;
      t.fontFamily = "Inter, 'Segoe UI', Roboto, sans-serif";
      t.fontWeight = "600";
      tag.addControl(t);
      ui.addControl(tag);
      labels.push({ anchor, tag, line, w, h });
    }

    // Posicionamento sem sobreposição: cada rótulo tenta alturas acima/abaixo
    // da peça até achar um lugar livre; uma linha-guia liga rótulo e peça.
    const project = (n: TransformNode): Vector3 => {
      const vp = this.scene.activeCamera!.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
      return Vector3.Project(n.getAbsolutePosition(), Matrix.IdentityReadOnly, this.scene.getTransformMatrix(), vp);
    };
    const offsets = [-56, -92, -128, 44, 80, 116, -164, 152].map((o) => o * k);
    this.scene.onBeforeRenderObservable.add(() => {
      if (!ui.rootContainer.isVisible) return;
      const W = engine.getRenderWidth();
      const H = engine.getRenderHeight();
      const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
      const items = labels.map((l) => ({ l, p: project(l.anchor) })).sort((a, b) => a.p.x - b.p.x);
      for (const { l, p } of items) {
        const visible = p.z > 0 && p.z < 1 && p.x > 0 && p.x < W && p.y > 0 && p.y < H;
        l.tag.isVisible = l.line.isVisible = visible;
        if (!visible) continue;
        let rect = { x: 0, y: 0, w: l.w, h: l.h };
        for (const off of offsets) {
          const cand = {
            x: Math.min(Math.max(p.x - l.w / 2, 8), W - l.w - 8),
            y: Math.min(Math.max(p.y + off - l.h / 2, 8), H - l.h - 8),
            w: l.w,
            h: l.h,
          };
          rect = cand;
          const pad = 6 * k;
          if (!placed.some((r) => cand.x < r.x + r.w + pad && cand.x + cand.w + pad > r.x && cand.y < r.y + r.h + pad && cand.y + cand.h + pad > r.y)) break;
        }
        placed.push(rect);
        l.tag.left = `${rect.x}px`;
        l.tag.top = `${rect.y}px`;
        l.line.x1 = p.x;
        l.line.y1 = p.y;
        l.line.x2 = rect.x + rect.w / 2;
        l.line.y2 = rect.y + (rect.y > p.y ? 0 : rect.h);
      }
    });
    this.labelControls = labels.map((l) => l.tag);
    this.labelsUi = ui;
  }
}

/** Componente do catálogo para um nó (sobe pelos ancestrais). */
export function identify(node: Node): ComponentInfo | null {
  for (let n: Node | null = node; n; n = n.parent) {
    const name = n.name.replace(/_primitive\d+$/, "");
    const c = COMPONENTS.find((x) => x.match.test(name));
    if (c) return c;
  }
  return null;
}

function meshesOf(node: TransformNode): AbstractMesh[] {
  const own = node instanceof AbstractMesh ? [node] : [];
  return [...own, ...node.getChildMeshes(false)].filter((m) => m.getTotalVertices() > 0);
}

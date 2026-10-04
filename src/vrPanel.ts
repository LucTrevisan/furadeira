import { type Mesh, MeshBuilder, Scene, Vector3 } from "@babylonjs/core";
import {
  AdvancedDynamicTexture,
  Button,
  Control,
  Ellipse,
  Rectangle,
  Slider,
  StackPanel,
  TextBlock,
} from "@babylonjs/gui";
import { DRILL } from "./config";
import type { DrillController, DrillState } from "./drillController";

export interface VRPanelActions {
  toggleInspect: () => void;
  reset: () => void;
  explodeToggle: () => void;
  explodeSet: (factor: number) => void;
}

/**
 * Painel 3D para o headset. Elementos HTML NÃO aparecem dentro do VR, por
 * isso os mesmos comandos são oferecidos aqui (GUI do Babylon numa malha),
 * clicáveis com o raio dos controles. Chama exatamente as mesmas funções
 * do DrillController que o painel HTML.
 */
export class VRPanel {
  readonly mesh: Mesh;
  private readonly adt: AdvancedDynamicTexture;
  private readonly led: Ellipse;
  private readonly powerText: TextBlock;
  private readonly rpmText: TextBlock;
  private readonly setpointText: TextBlock;
  private readonly dirText: TextBlock;
  private readonly slider: Slider;
  private readonly inspectBtn: Button;
  private readonly explodeBtn: Button;
  private readonly explodeSlider: Slider;
  private lastRpmText = "";
  private syncingSlider = false;
  private syncingExplode = false;

  constructor(scene: Scene, drill: DrillController, actions: VRPanelActions) {
    // Proporção do plano = proporção da textura (1024 × 830).
    this.mesh = MeshBuilder.CreatePlane("painel_vr", { width: 0.44, height: 0.44 * (830 / 1024) }, scene);
    this.mesh.isPickable = true;
    this.adt = AdvancedDynamicTexture.CreateForMesh(this.mesh, 1024, 830);

    const frame = new Rectangle("frame");
    frame.background = "#1d2227";
    frame.color = "#f5a623";
    frame.thickness = 6;
    frame.cornerRadius = 24;
    this.adt.addControl(frame);

    const col = new StackPanel("col");
    col.isVertical = true;
    col.paddingTop = "18px";
    frame.addControl(col);

    // Linha de estado: LED + LIGADA/DESLIGADA + sentido
    const stateRow = row("stateRow", 80);
    this.led = new Ellipse("led");
    this.led.width = "44px";
    this.led.height = "44px";
    this.led.thickness = 0;
    this.led.background = "#5a1a1c";
    stateRow.addControl(this.led);
    this.powerText = text("power", "DESLIGADA", 52, "#ff8a8d", 420);
    this.powerText.paddingLeft = "18px";
    stateRow.addControl(this.powerText);
    this.dirText = text("dir", "↻ HORÁRIO", 40, "#9aa5b0", 400);
    stateRow.addControl(this.dirText);
    col.addControl(stateRow);

    // RPM atual (grande)
    this.rpmText = text("rpm", "0 RPM", 110, "#f5a623", 980);
    this.rpmText.height = "130px";
    this.rpmText.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    col.addControl(this.rpmText);

    // Velocidade selecionada + slider
    this.setpointText = text("setpoint", "", 36, "#c9d1d9", 900);
    this.setpointText.height = "50px";
    col.addControl(this.setpointText);

    this.slider = new Slider("slider");
    this.slider.minimum = 0;
    this.slider.maximum = DRILL.maxRPM;
    this.slider.step = 50;
    this.slider.height = "70px";
    this.slider.width = "900px";
    this.slider.color = "#f5a623";
    this.slider.background = "#3a424a";
    this.slider.thumbWidth = "56px";
    this.slider.isThumbCircle = true;
    this.slider.onValueChangedObservable.add((v) => {
      if (!this.syncingSlider) drill.setMandrilRPM(v);
    });
    col.addControl(this.slider);

    // Botões (mesmas funções do painel HTML)
    const r1 = row("r1", 120);
    r1.addControl(button("on", "LIGAR", "#1f8f4e", () => drill.startDrill()));
    r1.addControl(button("off", "DESLIGAR", "#b3363a", () => drill.stopDrill()));
    r1.addControl(button("minus", "− RPM", "#3a424a", () => drill.setMandrilRPM(drill.state.setpointRPM - DRILL.rpmStep), 200));
    r1.addControl(button("plus", "+ RPM", "#3a424a", () => drill.setMandrilRPM(drill.state.setpointRPM + DRILL.rpmStep), 200));
    col.addControl(r1);

    const r2 = row("r2", 120);
    r2.addControl(button("dir", "INVERTER", "#a06a10", () => drill.toggleDirection()));
    r2.addControl(button("reset", "RESET", "#3a424a", () => actions.reset()));
    this.inspectBtn = button("inspect", "APROXIMAR", "#3b8beb", () => actions.toggleInspect(), 400);
    r2.addControl(this.inspectBtn);
    col.addControl(r2);

    // Vista explodida: botão animado + slider manual.
    const r3 = row("r3", 120);
    this.explodeBtn = button("explode", "EXPLODIR", "#4b3a8f", () => actions.explodeToggle(), 320);
    r3.addControl(this.explodeBtn);
    this.explodeSlider = new Slider("explodeSlider");
    this.explodeSlider.minimum = 0;
    this.explodeSlider.maximum = 1;
    this.explodeSlider.value = 0;
    this.explodeSlider.height = "70px";
    this.explodeSlider.width = "620px";
    this.explodeSlider.paddingLeft = "20px";
    this.explodeSlider.color = "#9b87f5";
    this.explodeSlider.background = "#3a424a";
    this.explodeSlider.thumbWidth = "56px";
    this.explodeSlider.isThumbCircle = true;
    this.explodeSlider.onValueChangedObservable.add((v) => {
      if (!this.syncingExplode) actions.explodeSet(v);
    });
    r3.addControl(this.explodeSlider);
    col.addControl(r3);

    drill.onChange((s) => this.renderState(s));
    this.renderState(drill.state);
    this.setEnabled(false);
  }

  /** Posiciona o painel como um "púlpito" inclinado, voltado para o usuário (−Z). */
  placeAt(position: Vector3, tiltRad = 0.45): void {
    this.mesh.position.copyFrom(position);
    this.mesh.rotation.set(tiltRad, 0, 0);
  }

  setEnabled(enabled: boolean): void {
    this.mesh.setEnabled(enabled);
  }

  setInspecting(inspecting: boolean): void {
    if (this.inspectBtn.textBlock) this.inspectBtn.textBlock.text = inspecting ? "AFASTAR" : "APROXIMAR";
  }

  setExplode(factor: number): void {
    if (this.explodeBtn.textBlock) this.explodeBtn.textBlock.text = factor > 0.5 ? "MONTAR" : "EXPLODIR";
    if (Math.abs(this.explodeSlider.value - factor) > 1e-3) {
      this.syncingExplode = true;
      this.explodeSlider.value = factor;
      this.syncingExplode = false;
    }
  }

  /** Atualização do RPM (chamada com taxa limitada: redesenhar a textura custa caro no Quest). */
  tick(currentRPM: number): void {
    const t = `${Math.round(currentRPM)} RPM`;
    if (t !== this.lastRpmText) {
      this.rpmText.text = t;
      this.lastRpmText = t;
    }
  }

  private renderState(s: DrillState): void {
    this.led.background = s.power ? "#2ecc71" : "#5a1a1c";
    this.powerText.text = s.power ? "LIGADA" : "DESLIGADA";
    this.powerText.color = s.power ? "#2ecc71" : "#ff8a8d";
    this.dirText.text = s.direction === 1 ? "↻ HORÁRIO" : "↺ ANTI-HORÁRIO";
    this.setpointText.text = `Velocidade selecionada: ${s.setpointRPM} RPM`;
    if (this.slider.value !== s.setpointRPM) {
      this.syncingSlider = true;
      this.slider.value = s.setpointRPM;
      this.syncingSlider = false;
    }
  }
}

function row(name: string, heightPx: number): StackPanel {
  const r = new StackPanel(name);
  r.isVertical = false;
  r.height = `${heightPx}px`;
  r.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
  return r;
}

function text(name: string, value: string, size: number, color: string, widthPx: number): TextBlock {
  const t = new TextBlock(name, value);
  t.fontSize = size;
  t.color = color;
  t.fontWeight = "bold";
  t.fontFamily = "Consolas, monospace";
  t.width = `${widthPx}px`;
  t.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  return t;
}

function button(name: string, label: string, color: string, onClick: () => void, widthPx = 280): Button {
  const b = Button.CreateSimpleButton(name, label);
  b.width = `${widthPx}px`;
  b.height = "100px";
  b.paddingLeft = "8px";
  b.paddingRight = "8px";
  b.color = "white";
  b.background = color;
  b.cornerRadius = 14;
  b.thickness = 0;
  b.fontSize = 38;
  b.fontWeight = "bold";
  b.onPointerUpObservable.add(() => onClick());
  return b;
}

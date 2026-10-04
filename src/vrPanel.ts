import { type Mesh, MeshBuilder, Scene, Vector3 } from "@babylonjs/core";
import {
  AdvancedDynamicTexture,
  Button,
  Control,
  Ellipse,
  Grid,
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

/** Mesmas cores do design system (style.css). */
const C = {
  bg: "#14181c",
  card: "#1a1f24",
  inset: "#0b0e11",
  border: "#36404a",
  text: "#e8ecef",
  muted: "#8a96a2",
  accent: "#f2a33a",
  success: "#34c27a",
  successBg: "#23955c",
  danger: "#ea5455",
  neutral: "#2a323a",
};
const FONT = "Inter, 'Segoe UI', Roboto, sans-serif";
const MONO = "'JetBrains Mono', Consolas, monospace";

/**
 * Painel espacial para o headset. Elementos HTML NÃO aparecem dentro do VR,
 * por isso os comandos existem aqui (GUI do Babylon numa malha), clicáveis
 * com o raio dos controles. Alvos grandes; chama as MESMAS funções do
 * DrillController que o painel HTML.
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
  private readonly powerBtn: Button;
  private readonly inspectBtn: Button;
  private readonly explodeBtn: Button;
  private readonly explodeSlider: Slider;
  private lastRpmText = "";
  private syncingSlider = false;
  private syncingExplode = false;

  constructor(
    scene: Scene,
    drill: DrillController,
    actions: VRPanelActions,
  ) {
    // Proporção do plano = proporção da textura (1024 × 860).
    this.mesh = MeshBuilder.CreatePlane("painel_vr", { width: 0.46, height: 0.46 * (860 / 1024) }, scene);
    this.mesh.isPickable = true;
    this.adt = AdvancedDynamicTexture.CreateForMesh(this.mesh, 1024, 860);

    const frame = new Rectangle("frame");
    frame.background = C.bg;
    frame.color = C.border;
    frame.thickness = 4;
    frame.cornerRadius = 28;
    this.adt.addControl(frame);

    const accent = new Rectangle("accent");
    accent.height = "8px";
    accent.thickness = 0;
    accent.background = C.accent;
    accent.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    frame.addControl(accent);

    const col = new StackPanel("col");
    col.isVertical = true;
    col.paddingTop = "26px";
    col.paddingLeft = "40px";
    col.paddingRight = "40px";
    frame.addControl(col);

    // Cabeçalho: título + estado (cor + ícone + texto).
    const head = new Grid("head");
    head.height = "64px";
    head.addColumnDefinition(0.5);
    head.addColumnDefinition(0.5);
    const title = text("title", "FURADEIRA MANUAL", 34, C.muted, FONT);
    title.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    head.addControl(title, 0, 0);
    const pill = new StackPanel("pill");
    pill.isVertical = false;
    pill.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
    this.led = new Ellipse("led");
    this.led.width = "30px";
    this.led.height = "30px";
    this.led.thickness = 0;
    pill.addControl(this.led);
    this.powerText = text("power", "", 36, C.danger, FONT);
    this.powerText.width = "380px";
    this.powerText.paddingLeft = "14px";
    this.powerText.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    pill.addControl(this.powerText);
    head.addControl(pill, 0, 1);
    col.addControl(head);

    // Leitura principal: RPM grande.
    const readout = new Rectangle("readout");
    readout.height = "210px";
    readout.background = C.inset;
    readout.color = C.border;
    readout.thickness = 2;
    readout.cornerRadius = 18;
    const rcol = new StackPanel("rcol");
    readout.addControl(rcol);
    this.rpmText = text("rpm", "0 RPM", 112, C.accent, MONO);
    this.rpmText.height = "140px";
    rcol.addControl(this.rpmText);
    const sub = new StackPanel("sub");
    sub.isVertical = false;
    sub.height = "54px";
    sub.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    this.setpointText = text("setpoint", "", 32, C.muted, FONT);
    this.setpointText.width = "430px";
    sub.addControl(this.setpointText);
    this.dirText = text("dir", "", 32, C.text, FONT);
    this.dirText.width = "430px";
    sub.addControl(this.dirText);
    rcol.addControl(sub);
    col.addControl(readout);
    col.addControl(spacer(22));

    // Velocidade: [ − ]  slider  [ + ]
    const speed = new StackPanel("speed");
    speed.isVertical = false;
    speed.height = "110px";
    speed.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    speed.addControl(button("minus", "−", C.neutral, () => drill.setMandrilRPM(drill.state.setpointRPM - DRILL.rpmStep), 140, 64));
    this.slider = slider("slider", 0, DRILL.maxRPM, 580);
    this.slider.step = 50;
    this.slider.onValueChangedObservable.add((v) => {
      if (!this.syncingSlider) drill.setMandrilRPM(v);
    });
    speed.addControl(this.slider);
    speed.addControl(button("plus", "+", C.neutral, () => drill.setMandrilRPM(drill.state.setpointRPM + DRILL.rpmStep), 140, 64));
    col.addControl(speed);
    col.addControl(spacer(10));

    // Ações principais: LIGAR/DESLIGAR (um botão grande) + INVERTER.
    const main = new StackPanel("main");
    main.isVertical = false;
    main.height = "128px";
    main.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    this.powerBtn = button("power", "LIGAR", C.successBg, () => drill.togglePower(), 470, 48);
    main.addControl(this.powerBtn);
    main.addControl(button("dir", "INVERTER", C.neutral, () => drill.toggleDirection(), 410, 44));
    col.addControl(main);

    // Funções secundárias.
    const sec = new StackPanel("sec");
    sec.isVertical = false;
    sec.height = "110px";
    sec.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    sec.addControl(button("reset", "RESET", C.neutral, () => actions.reset(), 220, 34));
    this.inspectBtn = button("inspect", "APROXIMAR", C.neutral, () => actions.toggleInspect(), 300, 34);
    sec.addControl(this.inspectBtn);
    this.explodeBtn = button("explode", "EXPLODIR", C.neutral, () => actions.explodeToggle(), 360, 34);
    sec.addControl(this.explodeBtn);
    col.addControl(sec);

    // Vista explodida (ajuste fino).
    const ex = new StackPanel("ex");
    ex.isVertical = false;
    ex.height = "80px";
    ex.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    const exLabel = text("exLabel", "VISTA EXPLODIDA", 28, C.muted, FONT);
    exLabel.width = "290px";
    exLabel.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    ex.addControl(exLabel);
    this.explodeSlider = slider("explodeSlider", 0, 1, 590);
    this.explodeSlider.onValueChangedObservable.add((v) => {
      if (!this.syncingExplode) actions.explodeSet(v);
    });
    ex.addControl(this.explodeSlider);
    col.addControl(ex);

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

  /** Atualização do RPM (taxa limitada: redesenhar a textura custa caro no Quest). */
  tick(currentRPM: number): void {
    const t = `${Math.round(currentRPM)} RPM`;
    if (t !== this.lastRpmText) {
      this.rpmText.text = t;
      this.lastRpmText = t;
    }
  }

  private renderState(s: DrillState): void {
    this.led.background = s.power ? C.success : C.danger;
    this.powerText.text = s.power ? "▶ EM OPERAÇÃO" : "■ DESLIGADA";
    this.powerText.color = s.power ? C.success : "#ff8b8c";
    this.dirText.text = s.direction === 1 ? "↻ Horário" : "↺ Anti-horário";
    this.setpointText.text = `Selecionada: ${s.setpointRPM} RPM`;
    if (this.powerBtn.textBlock) this.powerBtn.textBlock.text = s.power ? "DESLIGAR" : "LIGAR";
    this.powerBtn.background = s.power ? "#3a1c1e" : C.successBg;
    this.powerBtn.color = s.power ? "#ff8b8c" : "white";
    this.powerBtn.thickness = s.power ? 4 : 0;
    if (this.slider.value !== s.setpointRPM) {
      this.syncingSlider = true;
      this.slider.value = s.setpointRPM;
      this.syncingSlider = false;
    }
  }
}

function spacer(h: number): Rectangle {
  const r = new Rectangle();
  r.height = `${h}px`;
  r.thickness = 0;
  return r;
}

function text(name: string, value: string, size: number, color: string, family: string): TextBlock {
  const t = new TextBlock(name, value);
  t.fontSize = size;
  t.color = color;
  t.fontWeight = "bold";
  t.fontFamily = family;
  return t;
}

function slider(name: string, min: number, max: number, widthPx: number): Slider {
  const s = new Slider(name);
  s.minimum = min;
  s.maximum = max;
  s.value = min;
  s.height = "70px";
  s.width = `${widthPx}px`;
  s.paddingLeft = "24px";
  s.paddingRight = "24px";
  s.color = C.accent;
  s.background = C.neutral;
  s.borderColor = C.border;
  s.thumbColor = "#f4f6f8";
  s.thumbWidth = "60px";
  s.isThumbCircle = true;
  return s;
}

function button(name: string, label: string, color: string, onClick: () => void, widthPx: number, fontSize: number): Button {
  const b = Button.CreateSimpleButton(name, label);
  b.width = `${widthPx}px`;
  b.height = "104px";
  b.paddingLeft = "10px";
  b.paddingRight = "10px";
  b.color = "white";
  b.background = color;
  b.cornerRadius = 16;
  b.thickness = 0;
  b.fontSize = fontSize;
  b.fontWeight = "bold";
  b.fontFamily = FONT;
  // Feedback visual de toque com o raio do controle.
  b.pointerEnterAnimation = () => (b.alpha = 0.85);
  b.pointerOutAnimation = () => (b.alpha = 1);
  b.pointerDownAnimation = () => (b.scaleX = b.scaleY = 0.96);
  b.pointerUpAnimation = () => (b.scaleX = b.scaleY = 1);
  b.onPointerUpObservable.add(() => onClick());
  return b;
}

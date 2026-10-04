import { DRILL, VISUAL } from "./config";
import type { DrillController, DrillState } from "./drillController";

export type WsStatus = "disconnected" | "connecting" | "connected" | "error";

export interface UIHandlers {
  onEnterVR: () => void;
  /** Alterna o foco no mandril; retorna true se ficou focado. */
  onFocusToggle: () => boolean;
  onRealSpeedChange: (real: boolean) => void;
  onWsToggle: (url: string) => void;
  /** RESET: estado padrão da furadeira + posição original. */
  onReset: () => void;
  /** Vista explodida: alterna montar/explodir (animado). */
  onExplodeToggle: () => void;
  /** Vista explodida: fator 0..1 vindo do slider. */
  onExplodeSet: (factor: number) => void;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Elemento #${id} não encontrado no HTML`);
  return el as T;
};

/**
 * Painel de controle HTML (desktop e celular; mouse e toque).
 * Não contém lógica da furadeira: apenas chama o DrillController e reflete
 * seu estado. Dentro do headset quem aparece é o painel 3D (vrPanel.ts).
 */
export class ControlPanelUI {
  private readonly status = $<HTMLParagraphElement>("statusMsg");
  private readonly loading = $<HTMLDivElement>("loading");
  private readonly loadingBar = $<HTMLDivElement>("loadingBar");
  private readonly loadingPct = $<HTMLParagraphElement>("loadingPct");
  private readonly panel = $<HTMLElement>("panel");
  private readonly led = $<HTMLSpanElement>("led");
  private readonly powerLabel = $<HTMLSpanElement>("powerLabel");
  private readonly rpmValue = $<HTMLSpanElement>("rpmValue");
  private readonly setpointValue = $<HTMLElement>("setpointValue");
  private readonly slider = $<HTMLInputElement>("rpmSlider");
  private readonly dirIcon = document.getElementById("dirIcon") as unknown as SVGElement;
  private readonly dirLabel = $<HTMLSpanElement>("dirLabel");
  private readonly btnOn = $<HTMLButtonElement>("btnOn");
  private readonly btnOff = $<HTMLButtonElement>("btnOff");
  private readonly btnVR = $<HTMLButtonElement>("btnVR");
  private readonly btnFocus = $<HTMLButtonElement>("btnFocus");
  private readonly wsUrl = $<HTMLInputElement>("wsUrl");
  private readonly btnWs = $<HTMLButtonElement>("btnWs");
  private readonly wsStatus = $<HTMLSpanElement>("wsStatus");

  private readonly explodeSlider = $<HTMLInputElement>("explodeSlider");
  private readonly explodeValue = $<HTMLElement>("explodeValue");
  private readonly btnExplode = $<HTMLButtonElement>("btnExplode");

  private lastRpmText = "";
  private lastSpinning = false;

  constructor(
    drill: DrillController,
    handlers: UIHandlers,
    initialWsUrl: string,
  ) {
    this.slider.max = String(DRILL.maxRPM);
    this.slider.addEventListener("input", () => drill.setMandrilRPM(Number(this.slider.value)));

    this.btnOn.addEventListener("click", () => drill.startDrill());
    this.btnOff.addEventListener("click", () => drill.stopDrill());
    $("btnDir").addEventListener("click", () => drill.toggleDirection());
    $("btnReset").addEventListener("click", () => handlers.onReset());
    this.btnVR.addEventListener("click", () => handlers.onEnterVR());
    this.btnFocus.addEventListener("click", () => {
      const focused = handlers.onFocusToggle();
      this.btnFocus.textContent = focused ? "VISÃO GERAL" : "FOCAR MANDRIL";
    });

    this.explodeSlider.addEventListener("input", () => handlers.onExplodeSet(Number(this.explodeSlider.value) / 100));
    this.btnExplode.addEventListener("click", () => handlers.onExplodeToggle());
    this.setExplodeAvailable(false);

    const chk = $<HTMLInputElement>("chkRealSpeed");
    chk.checked = !VISUAL.antiStrobeEnabledByDefault;
    chk.addEventListener("change", () => handlers.onRealSpeedChange(chk.checked));

    this.wsUrl.value = initialWsUrl;
    this.btnWs.addEventListener("click", () => handlers.onWsToggle(this.wsUrl.value.trim()));

    const toggle = $<HTMLButtonElement>("panelToggle");
    toggle.addEventListener("click", () => {
      const collapsed = this.panel.classList.toggle("collapsed");
      toggle.setAttribute("aria-expanded", String(!collapsed));
    });

    // Atalhos de teclado: Espaço liga/desliga, R inverte, ←/→ ajustam o RPM.
    window.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "BUTTON")) return;
      if (e.code === "Space") { drill.togglePower(); e.preventDefault(); }
      else if (e.key === "r" || e.key === "R") drill.toggleDirection();
      else if (e.key === "e" || e.key === "E") handlers.onExplodeToggle();
      else if (e.key === "ArrowRight" || e.key === "ArrowUp") drill.setMandrilRPM(drill.state.setpointRPM + DRILL.rpmStep);
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") drill.setMandrilRPM(drill.state.setpointRPM - DRILL.rpmStep);
    });

    drill.onChange((s) => this.renderState(s));
    this.renderState(drill.state);
  }

  /** Atualização em tempo real do RPM (chamada com taxa limitada). */
  tick(currentRPM: number): void {
    const text = String(Math.round(currentRPM));
    if (text !== this.lastRpmText) {
      this.rpmValue.textContent = text;
      this.lastRpmText = text;
    }
    const spinning = currentRPM > 0.5;
    if (spinning !== this.lastSpinning) {
      this.dirIcon.classList.toggle("spinning", spinning);
      this.lastSpinning = spinning;
    }
  }

  setStatus(msg: string, kind: "info" | "warn" | "error" = "info"): void {
    this.status.textContent = msg;
    this.status.classList.toggle("warn", kind === "warn");
    this.status.classList.toggle("error", kind === "error");
    this.status.title = msg;
  }

  setLoadingProgress(fraction: number): void {
    if (fraction < 0) {
      this.loadingPct.textContent = "carregando…";
      return;
    }
    const pct = Math.round(fraction * 100);
    this.loadingBar.style.width = `${pct}%`;
    this.loadingPct.textContent = `${pct}%`;
  }

  hideLoading(): void {
    this.loading.classList.add("hidden");
  }

  setVRAvailable(available: boolean, reason = ""): void {
    this.btnVR.disabled = !available;
    this.btnVR.title = available ? "Entrar na experiência imersiva" : reason;
  }

  /** Reflete o fator da vista explodida (0..1) no slider, rótulo e botão. */
  setExplode(factor: number): void {
    const pct = Math.round(factor * 100);
    this.explodeValue.textContent = `${pct}%`;
    if (Number(this.explodeSlider.value) !== pct) this.explodeSlider.value = String(pct);
    this.btnExplode.textContent = factor > 0.5 ? "MONTAR" : "EXPLODIR";
  }

  setExplodeAvailable(available: boolean): void {
    this.explodeSlider.disabled = !available;
    this.btnExplode.disabled = !available;
  }

  setFocusAvailable(available: boolean): void {
    this.btnFocus.disabled = !available;
  }

  setWsStatus(status: WsStatus, detail = ""): void {
    const labels: Record<WsStatus, string> = {
      disconnected: "desconectado",
      connecting: "conectando…",
      connected: "conectado",
      error: "erro",
    };
    this.wsStatus.textContent = labels[status];
    this.wsStatus.title = detail;
    this.wsStatus.className = "badge" + (status === "connected" ? " ok" : status === "error" ? " err" : status === "connecting" ? " wait" : "");
    this.btnWs.textContent = status === "disconnected" || status === "error" ? "CONECTAR" : "DESCONECTAR";
  }

  private renderState(s: DrillState): void {
    this.led.classList.toggle("on", s.power);
    this.powerLabel.classList.toggle("on", s.power);
    this.powerLabel.textContent = s.power ? "LIGADA" : "DESLIGADA";
    this.btnOn.disabled = s.power;
    this.btnOff.disabled = !s.power;

    this.setpointValue.textContent = String(s.setpointRPM);
    if (Number(this.slider.value) !== s.setpointRPM) this.slider.value = String(s.setpointRPM);

    const cw = s.direction === 1;
    this.dirLabel.textContent = cw ? "HORÁRIO" : "ANTI-HORÁRIO";
    this.dirIcon.classList.toggle("ccw", !cw);
  }
}

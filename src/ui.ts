import type { ComponentHit } from "./components";
import { DRILL, VISUAL } from "./config";
import type { DrillController, DrillState } from "./drillController";
import type { TrainingView } from "./training";
import type { IoTSensors, IoTTelemetry, LinkSettings } from "./websocket";

export type WsStatus = "disconnected" | "connecting" | "connected" | "error";
export type ToastKind = "ok" | "info" | "warn" | "err";

export interface UIHandlers {
  onEnterVR: () => void;
  /** Alterna o foco no mandril; retorna true se ficou focado. */
  onFocusToggle: () => boolean;
  onRealSpeedChange: (real: boolean) => void;
  /** Conectar/desconectar o ESP32 com a configuração do formulário. */
  onWsToggle: (settings: LinkSettings) => void;
  /** RESET: estado padrão da furadeira + posição original. */
  onReset: () => void;
  /** Vista explodida: alterna montar/explodir (animado). */
  onExplodeToggle: () => void;
  /** Vista explodida: fator 0..1 vindo do slider. */
  onExplodeSet: (factor: number) => void;
  /** Centraliza o equipamento na viewport. */
  onHome: () => void;
  /** Liga/desliga a identificação de peças por hover/clique. */
  onInspectToggle: (enabled: boolean) => void;
  onTrainPrimary: () => void;
  onTrainStop: () => void;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Elemento #${id} não encontrado no HTML`);
  return el as T;
};

type MachineState = "off" | "run" | "ramp" | "manual";

const STATE_VIEW: Record<MachineState, { icon: string; label: string }> = {
  off: { icon: "#i-stop", label: "Desligada" },
  run: { icon: "#i-power", label: "Em operação" },
  ramp: { icon: "#i-reset", label: "Ajustando" },
  manual: { icon: "#i-target", label: "Acionamento manual" },
};

const TOAST_ICON: Record<ToastKind, string> = { ok: "#i-power", info: "#i-info", warn: "#i-shield", err: "#i-close" };

/**
 * Painel HMI (desktop, tablet e celular; mouse, toque e teclado).
 * NÃO contém lógica da furadeira: só chama o DrillController/handlers e
 * reflete o estado. Dentro do headset quem aparece é o painel 3D (vrPanel.ts).
 */
export class ControlPanelUI {
  private readonly app = $<HTMLDivElement>("app");
  private readonly status = $<HTMLParagraphElement>("statusMsg");
  private readonly sysState = $<HTMLDivElement>("sysState");
  private readonly sysStateText = $<HTMLSpanElement>("sysStateText");
  private readonly loading = $<HTMLDivElement>("loading");
  private readonly loadingMsg = $<HTMLParagraphElement>("loadingMsg");
  private readonly loadingBar = $<HTMLDivElement>("loadingBar");
  private readonly loadingPct = $<HTMLParagraphElement>("loadingPct");
  private readonly stateBox = $<HTMLDivElement>("stateBox");
  private readonly stateIcon = document.querySelector("#stateIcon use") as SVGUseElement;
  private readonly powerLabel = $<HTMLSpanElement>("powerLabel");
  private readonly modeTag = $<HTMLSpanElement>("modeTag");
  private readonly rpmValue = $<HTMLSpanElement>("rpmValue");
  private readonly rpmBar = $<HTMLDivElement>("rpmBar");
  private readonly setpointValue = $<HTMLOutputElement>("setpointValue");
  private readonly slider = $<HTMLInputElement>("rpmSlider");
  private readonly dirIcon = document.getElementById("dirIcon") as unknown as SVGElement;
  private readonly dirLabel = $<HTMLSpanElement>("dirLabel");
  private readonly btnOn = $<HTMLButtonElement>("btnOn");
  private readonly btnOff = $<HTMLButtonElement>("btnOff");
  private readonly btnVR = $<HTMLButtonElement>("btnVR");
  private readonly btnSplashVR = $<HTMLButtonElement>("btnSplashVR");
  private readonly xrBadge = $<HTMLSpanElement>("xrBadge");
  private readonly xrBadgeText = $<HTMLSpanElement>("xrBadgeText");
  private readonly btnFocus = $<HTMLButtonElement>("btnFocus");
  private readonly btnFocusText = $<HTMLSpanElement>("btnFocusText");
  private readonly btnHome = $<HTMLButtonElement>("btnHome");
  private readonly wsUrl = $<HTMLInputElement>("wsUrl");
  private readonly btnWs = $<HTMLButtonElement>("btnWs");
  private readonly wsStatus = $<HTMLSpanElement>("wsStatus");
  private readonly explodeSlider = $<HTMLInputElement>("explodeSlider");
  private readonly explodeValue = $<HTMLOutputElement>("explodeValue");
  private readonly btnExplode = $<HTMLButtonElement>("btnExplode");
  private readonly btnExplodeText = $<HTMLSpanElement>("btnExplodeText");
  private readonly tooltip = $<HTMLDivElement>("tooltip");
  private readonly toasts = $<HTMLDivElement>("toasts");
  private readonly compInfo = $<HTMLDivElement>("compInfo");
  private readonly splash = $<HTMLDivElement>("splash");

  private lastRpmText = "";
  private lastSpinning = false;
  private lastMachine: MachineState | null = null;
  private prev: DrillState;
  private quietUntil = 0;
  private setpointToast: number | undefined;
  private setpointPulse: number | undefined;
  private explodeEnd: 0 | 1 = 0;
  private lastWs: WsStatus = "disconnected";

  constructor(
    private readonly drill: DrillController,
    handlers: UIHandlers,
    initialLink: LinkSettings,
  ) {
    this.prev = drill.state;

    // ---- Controle de rotação (mesmas chamadas de sempre) ----------------
    this.slider.max = String(DRILL.maxRPM);
    this.slider.addEventListener("input", () => drill.setMandrilRPM(Number(this.slider.value)));
    this.btnOn.addEventListener("click", () => drill.startDrill());
    this.btnOff.addEventListener("click", () => drill.stopDrill());
    $("btnDir").addEventListener("click", () => drill.toggleDirection());
    $("btnReset").addEventListener("click", () => {
      this.quietUntil = performance.now() + 400; // um único aviso para o reset
      handlers.onReset();
      this.toast("Equipamento reinicializado", "info");
    });

    // ---- VR, câmera e visualização ----------------------------------------
    this.btnVR.addEventListener("click", () => handlers.onEnterVR());
    this.btnHome.addEventListener("click", () => handlers.onHome());
    this.btnFocus.addEventListener("click", () => this.setFocused(handlers.onFocusToggle()));

    this.explodeSlider.addEventListener("input", () => handlers.onExplodeSet(Number(this.explodeSlider.value) / 100));
    this.btnExplode.addEventListener("click", () => handlers.onExplodeToggle());
    this.setExplodeAvailable(false);

    const chk = $<HTMLInputElement>("chkRealSpeed");
    chk.checked = !VISUAL.antiStrobeEnabledByDefault;
    chk.addEventListener("change", () => {
      handlers.onRealSpeedChange(chk.checked);
      this.toast(chk.checked ? "Velocidade visual real (1:1)" : "Velocidade visual reduzida (anti-estroboscópico)", "info");
    });
    const chkInspect = $<HTMLInputElement>("chkInspect");
    chkInspect.addEventListener("change", () => handlers.onInspectToggle(chkInspect.checked));

    // ---- Treinamento / ESP32 ----------------------------------------------
    $("btnTrain").addEventListener("click", () => handlers.onTrainPrimary());
    $("btnTrainStop").addEventListener("click", () => handlers.onTrainStop());
    this.setLinkSettings(initialLink);
    $<HTMLSelectElement>("iotTransport").addEventListener("change", () => this.showTransportFields());
    this.btnWs.addEventListener("click", () => handlers.onWsToggle(this.getLinkSettings()));

    // ---- Painel recolhível --------------------------------------------------
    $("btnPanel").addEventListener("click", () => this.setPanelOpen(this.app.classList.contains("panel-collapsed")));
    $("panelToggle").addEventListener("click", () => this.setPanelOpen(false));
    if (window.innerWidth <= 1100) this.setPanelOpen(false);

    // ---- Apresentação -------------------------------------------------------
    $("btnStart").addEventListener("click", () => this.hideSplash());
    this.btnSplashVR.addEventListener("click", () => {
      this.hideSplash();
      handlers.onEnterVR();
    });

    // ---- Teclado ------------------------------------------------------------
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (!this.splash.hidden) this.hideSplash();
        else if (window.innerWidth <= 1100) this.setPanelOpen(false);
        return;
      }
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "BUTTON" || t.tagName === "SUMMARY")) return;
      if (!this.splash.hidden) return;
      if (e.code === "Space") { drill.togglePower(); e.preventDefault(); }
      else if (e.key === "r" || e.key === "R") drill.toggleDirection();
      else if (e.key === "e" || e.key === "E") handlers.onExplodeToggle();
      else if (e.key === "h" || e.key === "H") handlers.onHome();
      else if (e.key === "ArrowRight" || e.key === "ArrowUp") drill.setMandrilRPM(drill.state.setpointRPM + DRILL.rpmStep);
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") drill.setMandrilRPM(drill.state.setpointRPM - DRILL.rpmStep);
    });

    drill.onChange((s) => this.renderState(s));
    this.renderState(drill.state, true);
    this.tick(0);
  }

  /** Atualização em tempo real (chamada com taxa limitada). */
  tick(currentRPM: number): void {
    const text = String(Math.round(currentRPM));
    if (text !== this.lastRpmText) {
      this.rpmValue.textContent = text;
      this.rpmBar.style.width = `${Math.min(100, (currentRPM / DRILL.maxRPM) * 100).toFixed(1)}%`;
      this.lastRpmText = text;
    }
    const spinning = currentRPM > 0.5;
    if (spinning !== this.lastSpinning) {
      this.dirIcon.classList.toggle("spinning", spinning);
      this.lastSpinning = spinning;
    }

    // Estado da máquina: cor + ícone + texto (nunca só cor).
    const s = this.drill.state;
    let m: MachineState;
    if (this.drill.isHandDriven && (spinning || !s.power)) m = "manual";
    else if (s.power) m = Math.abs(currentRPM - s.setpointRPM) > Math.max(15, s.setpointRPM * 0.02) ? "ramp" : "run";
    else m = spinning ? "ramp" : "off";
    // Na rampa, o texto diz o que está acontecendo (acelerar, frear, inverter).
    const signed = this.drill.signedRPM;
    const label =
      m !== "ramp"
        ? STATE_VIEW[m].label
        : !s.power
          ? "Desacelerando"
          : Math.abs(signed) > 0.5 && Math.sign(signed) !== s.direction
            ? "Invertendo sentido"
            : currentRPM < s.setpointRPM
              ? "Acelerando"
              : "Desacelerando";
    if (m !== this.lastMachine || label !== this.powerLabel.textContent) {
      this.lastMachine = m;
      this.stateBox.dataset.state = m;
      this.stateIcon.setAttribute("href", STATE_VIEW[m].icon);
      this.powerLabel.textContent = label;
      this.modeTag.textContent = m === "manual" ? "Manual" : "Motor";
      this.modeTag.classList.toggle("manual", m === "manual");
    }
  }

  setStatus(msg: string, kind: "info" | "warn" | "error" = "info"): void {
    this.status.textContent = msg;
    this.status.classList.toggle("warn", kind === "warn");
    this.status.classList.toggle("error", kind === "error");
    this.status.title = msg;
    if (kind === "error") this.setSystemState("error", "Falha");
  }

  setSystemState(kind: "loading" | "ready" | "error" | "xr", text: string): void {
    this.sysState.dataset.state = kind;
    this.sysStateText.textContent = text;
  }

  setLoadingMessage(msg: string): void {
    this.loadingMsg.textContent = msg;
  }

  setLoadingProgress(fraction: number): void {
    if (fraction < 0) {
      this.loadingPct.textContent = "carregando…";
      return;
    }
    const pct = Math.round(fraction * 100);
    this.loadingBar.style.width = `${pct}%`;
    this.loadingBar.parentElement?.setAttribute("aria-valuenow", String(pct));
    this.loadingPct.textContent = `${pct}%`;
  }

  hideLoading(): void {
    this.loading.classList.add("hidden");
  }

  /** Tela de apresentação (uma vez por sessão; ?nosplash desativa). */
  showSplash(): void {
    let seen = false;
    try {
      seen = sessionStorage.getItem("furadeira.splash") === "1";
    } catch {
      // armazenamento indisponível: mostra normalmente
    }
    if (seen || new URLSearchParams(location.search).has("nosplash")) return;
    this.splash.hidden = false;
    $("btnStart").focus();
  }

  hideSplash(): void {
    if (this.splash.hidden) return;
    this.splash.hidden = true;
    try {
      sessionStorage.setItem("furadeira.splash", "1");
    } catch {
      // ignora
    }
    $("renderCanvas").focus({ preventScroll: true });
  }

  setVRAvailable(available: boolean, reason = ""): void {
    for (const b of [this.btnVR, this.btnSplashVR]) {
      b.disabled = !available;
      b.title = available ? "Entrar na experiência imersiva (Meta Quest)" : reason;
    }
    this.xrBadge.dataset.state = available ? "ready" : "unavailable";
    this.xrBadgeText.textContent = available ? "WebXR ready" : "WebXR indisponível";
    this.xrBadge.title = available ? "Headset VR detectado: experiência imersiva disponível" : reason;
    $("splashXr").textContent = available
      ? "Headset VR detectado: experiência imersiva disponível."
      : `Modo desktop · ${reason || "VR indisponível neste navegador"}`;
  }

  /** Sessão VR ativa: oculta a interface desktop (não aparece no headset). */
  setXRActive(active: boolean): void {
    document.body.classList.toggle("xr-active", active);
    this.hideTooltip();
    if (active) this.setSystemState("xr", "Sessão VR ativa");
    else this.setSystemState("ready", "Sistema pronto");
    this.toast(active ? "Sessão VR iniciada" : "Sessão VR encerrada", "info");
  }

  /** Reflete o fator da vista explodida (0..1) no slider, rótulo e botão. */
  setExplode(factor: number): void {
    const pct = Math.round(factor * 100);
    this.explodeValue.textContent = `${pct}%`;
    if (Number(this.explodeSlider.value) !== pct) this.explodeSlider.value = String(pct);
    this.explodeSlider.style.setProperty("--fill", `${pct}%`);
    this.btnExplodeText.textContent = factor > 0.5 ? "Montar componentes" : "Explodir componentes";
    if (factor >= 0.999 && this.explodeEnd !== 1) {
      this.explodeEnd = 1;
      this.toast("Vista explodida ativada", "info");
    } else if (factor <= 0.001 && this.explodeEnd !== 0) {
      this.explodeEnd = 0;
      this.toast("Componentes montados", "info");
    }
  }

  setExplodeAvailable(available: boolean): void {
    this.explodeSlider.disabled = !available;
    this.btnExplode.disabled = !available;
  }

  setFocusAvailable(available: boolean): void {
    this.btnFocus.disabled = !available;
    this.btnHome.disabled = !available;
  }

  setFocused(focused: boolean): void {
    this.btnFocus.setAttribute("aria-pressed", String(focused));
    this.btnFocusText.textContent = focused ? "Visão geral" : "Focar mandril";
  }

  setWsStatus(status: WsStatus, detail = ""): void {
    const labels: Record<WsStatus, string> = {
      disconnected: "desconectado",
      connecting: "conectando…",
      connected: "conectado",
      error: "erro",
    };
    // MQTT: broker conectado, mas a placa ainda não respondeu.
    this.wsStatus.textContent = status === "connecting" && detail.includes("aguardando") ? "aguardando ESP32" : labels[status];
    this.wsStatus.title = detail;
    this.wsStatus.className = "badge" + (status === "connected" ? " ok" : status === "error" ? " err" : status === "connecting" ? " wait" : "");
    this.btnWs.textContent = status === "disconnected" || status === "error" ? "Conectar" : "Desconectar";
    if (status === "connected" && this.lastWs !== "connected") this.toast("ESP32 conectado", "ok");
    if (status === "disconnected" && this.lastWs === "connected") this.toast("ESP32 desconectado", "warn");
    this.lastWs = status;
  }

  // ------------------------------------------------------------- camada IoT

  getLinkSettings(): LinkSettings {
    const v = (id: string): string => $<HTMLInputElement>(id).value;
    return {
      transport: $<HTMLSelectElement>("iotTransport").value === "websocket" ? "websocket" : "mqtt",
      wsUrl: v("wsUrl").trim(),
      mqttUrl: v("mqttUrl").trim(),
      mqttTopic: v("mqttTopic").trim(),
      mqttUser: v("mqttUser").trim(),
      mqttPass: v("mqttPass"),
    };
  }

  setLinkSettings(s: LinkSettings): void {
    $<HTMLSelectElement>("iotTransport").value = s.transport;
    this.wsUrl.value = s.wsUrl;
    $<HTMLInputElement>("mqttUrl").value = s.mqttUrl;
    $<HTMLInputElement>("mqttTopic").value = s.mqttTopic;
    $<HTMLInputElement>("mqttUser").value = s.mqttUser;
    $<HTMLInputElement>("mqttPass").value = s.mqttPass;
    this.showTransportFields();
  }

  private showTransportFields(): void {
    const mqtt = $<HTMLSelectElement>("iotTransport").value === "mqtt";
    $("cfgMqtt").hidden = !mqtt;
    $("cfgWs").hidden = mqtt;
  }

  private lastVibLevel: IoTTelemetry["vibrationLevel"] = "normal";

  /**
   * MODO IoT (ESP32 conectado) × MODO NORMAL. Sem ESP32, tudo isto fica
   * oculto e a interface é exatamente a de antes.
   */
  setIoT(connected: boolean, t: IoTTelemetry | null, sensors: IoTSensors | null, device = ""): void {
    $("iotBadge").hidden = !connected;
    $("iotRow").hidden = !connected || !t;
    const mode = $("iotMode");
    mode.textContent = connected ? `Modo IoT · ${device || "ESP32"} online` : "Modo normal · ESP32 não conectado";
    mode.classList.toggle("on", connected);

    const states: Record<string, boolean> = {
      esp32: connected,
      encoder: connected && (sensors?.encoder ?? false),
      mpu6050: connected && (sensors?.mpu6050 ?? false),
      hcsr04: connected && (sensors?.hcsr04 ?? false),
      lcd: connected && (sensors?.lcd ?? false),
    };
    for (const li of document.querySelectorAll<HTMLLIElement>("#iotSensors li")) {
      const on = states[li.dataset.k ?? ""];
      const b = li.querySelector(".badge")!;
      b.textContent = on ? "online" : "offline";
      b.className = "badge" + (on ? " ok" : "");
    }

    if (!connected || !t) {
      this.lastVibLevel = "normal";
      return;
    }
    const labels = { normal: "Normal", attention: "Atenção", high: "Alta" } as const;
    const box = $("vibBox");
    box.dataset.level = t.vibrationLevel;
    $("vibLabel").textContent = sensors?.mpu6050 === false ? "Sem sensor" : labels[t.vibrationLevel];
    $("vibPct").textContent = `${Math.round(t.vibrationPercent)}%`;
    $("vibBar").style.width = `${t.vibrationPercent.toFixed(0)}%`;
    $("distValue").textContent = t.distance === null ? "--" : t.distance.toFixed(1);
    if (t.vibrationLevel === "high" && this.lastVibLevel !== "high") this.toast("Vibração alta detectada (MPU6050)", "warn");
    this.lastVibLevel = t.vibrationLevel;
  }

  // ------------------------------------------------- componentes / tooltip

  showComponent(hit: ComponentHit | null): void {
    this.compInfo.dataset.empty = String(!hit);
    if (!hit) return;
    $("compName").textContent = hit.info.name;
    $("compRole").textContent = hit.info.role;
    $("compDesc").textContent = hit.info.description;
    $("compPart").textContent = hit.partName;
  }

  setTooltip(hit: ComponentHit | null, clientX: number, clientY: number, hint = ""): void {
    if (!hit) return this.hideTooltip();
    const vp = this.tooltip.parentElement!.getBoundingClientRect();
    $("tooltipName").textContent = hit.info.name;
    $("tooltipRole").textContent = hit.info.role;
    let em = this.tooltip.querySelector("em");
    if (hint) {
      em ??= this.tooltip.appendChild(document.createElement("em"));
      em.textContent = hint;
    } else em?.remove();
    this.tooltip.hidden = false;
    const w = this.tooltip.offsetWidth;
    const h = this.tooltip.offsetHeight;
    const x = Math.min(clientX - vp.left + 16, vp.width - w - 8);
    const y = clientY - vp.top + 18 + h > vp.height - 8 ? clientY - vp.top - h - 12 : clientY - vp.top + 18;
    this.tooltip.style.left = `${Math.max(8, x)}px`;
    this.tooltip.style.top = `${Math.max(8, y)}px`;
    this.tooltip.classList.add("show");
  }

  hideTooltip(): void {
    this.tooltip.classList.remove("show");
    this.tooltip.hidden = true;
  }

  // ---------------------------------------------------------------- toasts

  toast(message: string, kind: ToastKind = "info", ms = 2600): void {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.setAttribute("role", kind === "err" ? "alert" : "status");
    el.innerHTML = `<svg class="ico" aria-hidden="true"><use href="${TOAST_ICON[kind]}"/></svg>`;
    el.append(document.createTextNode(message));
    this.toasts.append(el);
    while (this.toasts.children.length > 3) this.toasts.firstElementChild?.remove();
    window.setTimeout(() => {
      el.classList.add("out");
      window.setTimeout(() => el.remove(), 220);
    }, ms);
  }

  // ------------------------------------------------------------ treinamento

  readonly trainingView: TrainingView = {
    toast: (msg, kind = "info") => this.toast(msg, kind),
    render: (v) => {
      $("trainCard").dataset.active = String(v.active);
      $("trainStep").textContent = v.active ? (v.finished ? "Concluído" : `Etapa ${v.index + 1} de ${v.total}`) : `${v.total} etapas`;
      $("trainTitle").textContent = v.finished ? "Treinamento concluído" : v.title;
      $("trainText").textContent = v.text;
      const goal = $("trainGoal");
      goal.hidden = !v.active || v.finished;
      goal.textContent = v.goal;
      goal.classList.toggle("done", v.goalDone);
      const prog = $("trainProgress");
      prog.replaceChildren(
        ...[...v.progress].map((d, i) => {
          const s = document.createElement("i");
          if (d === "1") s.className = "done";
          else if (v.active && i === v.index) s.className = "current";
          return s;
        }),
      );
      const btn = $<HTMLButtonElement>("btnTrain");
      btn.textContent = !v.active || v.finished
        ? v.finished ? "Reiniciar treinamento" : "Iniciar treinamento"
        : v.index === v.total - 1 ? "Concluir" : "Próxima etapa";
      btn.disabled = v.active && !v.finished && !v.goalDone;
      $("btnTrainStop").hidden = !v.active;
    },
  };

  // ------------------------------------------------------------------------

  private setPanelOpen(open: boolean): void {
    this.app.classList.toggle("panel-collapsed", !open);
    for (const id of ["btnPanel", "panelToggle"]) $(id).setAttribute("aria-expanded", String(open));
  }

  private renderState(s: DrillState, initial = false): void {
    this.btnOn.disabled = s.power;
    this.btnOff.disabled = !s.power;

    this.setpointValue.textContent = String(s.setpointRPM);
    if (Number(this.slider.value) !== s.setpointRPM) this.slider.value = String(s.setpointRPM);
    this.slider.style.setProperty("--fill", `${(s.setpointRPM / DRILL.maxRPM) * 100}%`);

    const cw = s.direction === 1;
    this.dirLabel.textContent = cw ? "Horário" : "Anti-horário";
    this.dirIcon.classList.toggle("ccw", !cw);

    if (initial) return;
    const p = this.prev;
    this.prev = s;
    if (s.setpointRPM !== p.setpointRPM) {
      this.setpointValue.classList.add("changing");
      window.clearTimeout(this.setpointPulse);
      this.setpointPulse = window.setTimeout(() => this.setpointValue.classList.remove("changing"), 450);
    }
    if (performance.now() < this.quietUntil) return;
    if (s.power !== p.power) this.toast(s.power ? "Equipamento ligado" : "Equipamento desligado", s.power ? "ok" : "warn");
    if (s.direction !== p.direction) this.toast(`Sentido alterado para ${cw ? "horário" : "anti-horário"}`, "info");
    if (s.setpointRPM !== p.setpointRPM) {
      window.clearTimeout(this.setpointToast);
      this.setpointToast = window.setTimeout(() => this.toast(`Rotação ajustada para ${this.drill.state.setpointRPM} RPM`, "info"), 700);
    }
  }
}

import { DRILL } from "./config";

/** 1 = horário, −1 = anti-horário (ver DRILL.clockwiseViewedFrom). */
export type Direction = 1 | -1;

export interface DrillState {
  power: boolean;
  /** Velocidade selecionada (RPM), mantida mesmo com a furadeira desligada. */
  setpointRPM: number;
  direction: Direction;
}

export interface RemoteCommand {
  rpm?: number;
  power?: boolean;
  direction?: number;
}

/** ω [rad/s] = RPM × 2π / 60 */
export function rpmToRadPerSec(rpm: number): number {
  return (rpm * 2 * Math.PI) / 60;
}

/**
 * Estado e física simplificada da furadeira (sem dependência de Babylon,
 * da interface ou do WebXR). Todos os módulos — painel HTML, painel VR,
 * controles do Quest e WebSocket — chamam os mesmos métodos.
 */
export class DrillController {
  private power = false;
  private setpoint: number = DRILL.defaultRPM;
  private direction: Direction = 1;
  /** Velocidade instantânea com sinal (RPM). Varia em rampa até o alvo. */
  private speed = 0;
  /** Acionamento manual: "driving" = mão na manivela; "coasting" = soltou e desacelera. */
  private hand: "off" | "driving" | "coasting" = "off";
  private readonly listeners = new Set<(s: DrillState) => void>();

  // ------------------------------------------------------------------ API

  startDrill(): void {
    if (this.power) return;
    this.power = true;
    this.hand = "off"; // o motor assume
    this.emit();
  }

  stopDrill(): void {
    if (!this.power) return;
    this.power = false; // a rampa de desaceleração acontece em update()
    this.emit();
  }

  togglePower(): void {
    if (this.power) this.stopDrill();
    else this.startDrill();
  }

  /** Define a velocidade desejada (0 a DRILL.maxRPM). */
  setMandrilRPM(rpm: number): void {
    if (!Number.isFinite(rpm)) return;
    const clamped = Math.round(Math.min(DRILL.maxRPM, Math.max(0, rpm)));
    if (clamped === this.setpoint) return;
    this.setpoint = clamped;
    this.emit();
  }

  /** direction = 1 → horário; direction = −1 → anti-horário. */
  setRotationDirection(direction: number): void {
    const d: Direction = direction < 0 ? -1 : 1;
    if (d === this.direction) return;
    this.direction = d; // a inversão passa suavemente por zero em update()
    this.emit();
  }

  toggleDirection(): void {
    this.setRotationDirection(-this.direction);
  }

  /** Volta ao estado inicial: desligada, RPM padrão, sentido horário. */
  reset(): void {
    this.power = false;
    this.setpoint = DRILL.defaultRPM;
    this.direction = 1;
    if (this.hand === "driving") this.hand = "coasting";
    this.emit();
  }

  /** A mão assumiu a manivela: o motor desliga e a velocidade passa a vir da mão. */
  beginHandDrive(): void {
    this.hand = "driving";
    if (this.power) {
      this.power = false;
      this.emit();
    }
  }

  /** Velocidade medida da mão, já convertida para RPM do mandril (com sinal). */
  setHandSpeed(signedRPM: number): void {
    if (this.hand !== "driving" || !Number.isFinite(signedRPM)) return;
    this.speed = Math.max(-DRILL.maxRPM, Math.min(DRILL.maxRPM, signedRPM));
  }

  /** Soltou a manivela: continua girando e desacelera (spinDownRate). */
  endHandDrive(): void {
    if (this.hand === "driving") this.hand = "coasting";
  }

  /** Verdadeiro com a mão na manivela ou desacelerando depois de soltar. */
  get isHandDriven(): boolean {
    return this.hand !== "off";
  }

  /** Aplica um comando externo (ex.: ESP32) emitindo um único evento. */
  applyRemote(cmd: RemoteCommand): void {
    let changed = false;
    if (typeof cmd.rpm === "number" && Number.isFinite(cmd.rpm)) {
      const r = Math.round(Math.min(DRILL.maxRPM, Math.max(0, cmd.rpm)));
      if (r !== this.setpoint) { this.setpoint = r; changed = true; }
    }
    if (typeof cmd.power === "boolean" && cmd.power !== this.power) {
      this.power = cmd.power;
      changed = true;
    }
    if (typeof cmd.direction === "number" && cmd.direction !== 0) {
      const d: Direction = cmd.direction < 0 ? -1 : 1;
      if (d !== this.direction) { this.direction = d; changed = true; }
    }
    if (changed) this.emit();
  }

  // ------------------------------------------------------------- leitura

  get state(): DrillState {
    return { power: this.power, setpointRPM: this.setpoint, direction: this.direction };
  }

  /** RPM instantâneo (sempre positivo) — é o valor exibido na interface. */
  get currentRPM(): number {
    return Math.abs(this.speed);
  }

  /** RPM instantâneo com sinal (+ = sentido 1). */
  get signedRPM(): number {
    return this.speed;
  }

  /** Verdadeiro enquanto o mandril estiver girando ou mudando de velocidade. */
  get isMoving(): boolean {
    return this.speed !== 0 || this.targetSpeed() !== 0;
  }

  onChange(cb: (s: DrillState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ------------------------------------------------------------- simulação

  /** Avança a rampa de velocidade. `dt` em segundos (delta time real). */
  update(dt: number): void {
    if (this.hand === "driving") return; // velocidade definida pela mão
    const target = this.targetSpeed();
    if (this.speed === target) {
      if (this.hand === "coasting") this.hand = "off";
      return;
    }

    const reversing = this.speed !== 0 && Math.sign(target) !== Math.sign(this.speed);
    const accelerating = !reversing && Math.abs(target) > Math.abs(this.speed);
    const step = (accelerating ? DRILL.spinUpRate : DRILL.spinDownRate) * dt;
    const goal = reversing ? 0 : target; // ao inverter, primeiro para

    if (Math.abs(goal - this.speed) <= step) this.speed = goal;
    else this.speed += Math.sign(goal - this.speed) * step;
  }

  private targetSpeed(): number {
    return this.power ? this.direction * this.setpoint : 0;
  }

  private emit(): void {
    const s = this.state;
    this.listeners.forEach((cb) => cb(s));
  }
}

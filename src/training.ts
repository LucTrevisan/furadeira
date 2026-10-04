/**
 * Treinamento guiado em 5 etapas. Módulo INDEPENDENTE: só observa eventos
 * (notify) e atualiza o card "Treinamento"; não comanda a máquina.
 */
export type TrainingEvent =
  | { type: "camera" }
  | { type: "component"; id: string }
  | { type: "setpoint"; rpm: number }
  | { type: "power"; on: boolean }
  | { type: "direction" }
  | { type: "explode"; factor: number }
  | { type: "handDrive" };

interface Step {
  title: string;
  text: string;
  /** Texto do critério mostrado ao aluno. */
  goal: string;
  /** Retorna true quando o evento conclui a etapa. */
  check: (e: TrainingEvent, s: StepState) => boolean;
}

interface StepState {
  components: Set<string>;
}

const KEY_COMPONENTS = ["mandril", "castanhas", "coroa", "engrenagem-z43", "engrenagem-z15", "pinhao", "manivela"];

const STEPS: Step[] = [
  {
    title: "Conheça o equipamento",
    text: "Gire a visualização (arraste) e aproxime com a roda do mouse ou pinça para observar a furadeira de vários ângulos.",
    goal: "Movimente a câmera",
    check: (e) => e.type === "camera",
  },
  {
    title: "Identifique os componentes",
    text: "Clique em peças da furadeira para ver nome e função. Dica: a vista explodida separa as peças internas.",
    goal: "Identifique 3 componentes principais (mandril, engrenagens, manivela…)",
    check: (e, s) => {
      if (e.type === "component" && KEY_COMPONENTS.includes(e.id)) s.components.add(e.id);
      return s.components.size >= 3;
    },
  },
  {
    title: "Ajuste a velocidade",
    text: "No card Controle de rotação, use o controle deslizante ou as setas ← → para escolher a velocidade do mandril.",
    goal: "Ajuste a velocidade para 1500 RPM ou mais",
    check: (e) => e.type === "setpoint" && e.rpm >= 1500,
  },
  {
    title: "Acione o equipamento",
    text: "Pressione LIGAR (ou Espaço) e observe a aceleração gradual até a velocidade selecionada.",
    goal: "Ligue o equipamento",
    check: (e) => e.type === "power" && e.on,
  },
  {
    title: "Analise o funcionamento",
    text: "Inverta o sentido de rotação, ou gire a manivela à mão, e observe o trem de engrenagens: 1 volta da manivela ≈ 16,4 voltas do mandril.",
    goal: "Inverta a rotação ou acione a manivela",
    check: (e) => e.type === "direction" || e.type === "handDrive",
  },
];

export interface TrainingView {
  render: (v: {
    active: boolean;
    finished: boolean;
    index: number;
    total: number;
    title: string;
    text: string;
    goal: string;
    goalDone: boolean;
    progress: string;
  }) => void;
  toast: (msg: string, kind?: "ok" | "info") => void;
}

export class TrainingModule {
  private active = false;
  private finished = false;
  private index = 0;
  private done = false;
  private state: StepState = { components: new Set() };

  constructor(private readonly view: TrainingView) {
    this.render();
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Botão principal: iniciar / próxima etapa / concluir / reiniciar. */
  primary(): void {
    if (!this.active || this.finished) return this.start();
    if (this.index < STEPS.length - 1) {
      this.index++;
      this.resetStep();
    } else {
      this.finished = true;
      this.view.toast("Treinamento concluído. Bom trabalho!", "ok");
    }
    this.render();
  }

  stop(): void {
    this.active = false;
    this.finished = false;
    this.index = 0;
    this.resetStep();
    this.render();
  }

  notify(e: TrainingEvent): void {
    if (!this.active || this.finished || this.done) return;
    if (STEPS[this.index].check(e, this.state)) {
      this.done = true;
      this.view.toast(`Etapa ${this.index + 1} concluída: ${STEPS[this.index].title}`, "ok");
    }
    this.render();
  }

  private start(): void {
    this.active = true;
    this.finished = false;
    this.index = 0;
    this.resetStep();
    this.view.toast("Treinamento iniciado", "info");
    this.render();
  }

  private resetStep(): void {
    this.done = false;
    this.state = { components: new Set() };
  }

  private render(): void {
    const step = STEPS[this.index];
    const comp = this.index === 1 && this.active ? ` (${Math.min(3, this.state.components.size)}/3)` : "";
    this.view.render({
      active: this.active,
      finished: this.finished,
      index: this.index,
      total: STEPS.length,
      title: this.active ? step.title : "Treinamento guiado",
      text: this.active
        ? this.finished
          ? "Você percorreu as 5 etapas: conhecer, identificar, ajustar, acionar e analisar o equipamento."
          : step.text
        : "Percurso em 5 etapas: conheça o equipamento, identifique os componentes, ajuste a velocidade, acione e analise o funcionamento.",
      goal: step.goal + comp,
      goalDone: this.done,
      progress: STEPS.map((_, i) => (i < this.index || (i === this.index && (this.done || this.finished)) ? "1" : "0")).join(""),
    });
  }
}

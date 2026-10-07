import { Color3, DynamicTexture, Mesh, MeshBuilder, Scene, StandardMaterial, Texture, Vector3 } from "@babylonjs/core";

/**
 * Laboratório de usinagem ao redor da bancada (imersão no VR e fundo do
 * desktop). Tudo procedural, pensado para o Quest:
 *  - paredes e teto são planos SEM iluminação, com a luz "pintada" na textura;
 *  - móveis e máquinas são primitivas fundidas por material (≈10 draw calls);
 *  - nada projeta sombra, nada é clicável e tudo fica congelado.
 */

/** Limites da sala (m). O operador fica em (0, 0) olhando +Z; a furadeira em z≈0,6. */
export const LAB = { minX: -5.5, maxX: 5.5, minZ: -3.8, maxZ: 5.2, height: 3.6 };

type Ctx = CanvasRenderingContext2D;
type Painter = (c: Ctx, ppm: number, w: number, h: number) => void;

export function buildLabRoom(scene: Scene): Mesh[] {
  const W = LAB.maxX - LAB.minX;
  const D = LAB.maxZ - LAB.minZ;
  const H = LAB.height;
  const cx = (LAB.minX + LAB.maxX) / 2;
  const cz = (LAB.minZ + LAB.maxZ) / 2;
  const out: Mesh[] = [];

  // ---- Paredes (vistas de dentro; u cresce para a direita de quem olha) ----
  const wall = (name: string, width: number, pos: Vector3, rotY: number, paint: Painter): void => {
    const m = MeshBuilder.CreatePlane(name, { width, height: H }, scene);
    m.position = pos;
    m.rotation.y = rotY;
    m.material = unlit(scene, name, paintTexture(scene, name, width, H, 110, paint));
    out.push(m);
  };
  // Fundo (+Z): o que aparece atrás da bancada.
  wall("parede_fundo", W, new Vector3(cx, H / 2, LAB.maxZ), 0, (c, p, w, h) => {
    baseWall(c, p, w, h);
    windowsBand(c, p, [[0.6, 3.0], [7.8, 3.2]], h);
    pegboard(c, p, 3.9, 1.25, 3.2, 1.2, h);
    banner(c, p, w / 2, 2.8, "LABORATÓRIO DE USINAGEM", h);
    mandatory(c, p, 2.9, 1.45, "USE ÓCULOS", h);
    mandatory(c, p, 7.65, 1.45, "USE PROTETOR", h);
    warning(c, p, 8.6, 1.45, "PARTES GIRANTES", h);
  });
  // Esquerda (−X): janelas e quadro branco.
  wall("parede_esq", D, new Vector3(LAB.minX, H / 2, cz), -Math.PI / 2, (c, p, w, h) => {
    baseWall(c, p, w, h);
    windowsBand(c, p, [[0.4, 3.4], [7.4, 1.5]], h);
    whiteboard(c, p, 4.4, 1.35, 2.4, 1.0, h);
    notice(c, p, 1.2, 1.3, "PROCEDIMENTO", ["1. Fixe a peça", "2. Ajuste a rotação", "3. Proteja os olhos", "4. Retire a chave", "5. Limpe a bancada"], h);
  });
  // Direita (+X): porta, quadro elétrico, sinalização.
  wall("parede_dir", D, new Vector3(LAB.maxX, H / 2, cz), Math.PI / 2, (c, p, w, h) => {
    baseWall(c, p, w, h);
    // u cresce de z=+5,2 (fundo) para z=−3,8 (frente).
    door(c, p, 7.2, h);
    electricalPanel(c, p, 4.6, 1.1, h);
    warning(c, p, 4.95, 2.2, "RISCO ELÉTRICO", h);
    fireSign(c, p, 6.4, 1.6, h);
    windowsBand(c, p, [[0.4, 1.0]], h);
  });
  // Frente (−Z, atrás do operador): porta de entrada e relógio.
  wall("parede_frente", W, new Vector3(cx, H / 2, LAB.minZ), Math.PI, (c, p, w, h) => {
    baseWall(c, p, w, h);
    // u cresce de x=+5,5 para x=−5,5.
    door(c, p, 1.2, h);
    clock(c, p, 5.5, 2.75, h);
    notice(c, p, 3.2, 1.3, "EPI OBRIGATÓRIO", ["Óculos de proteção", "Calçado de segurança", "Cabelo preso", "Sem luvas na máquina"], h);
    notice(c, p, 9.8, 1.25, "PROGRAMA 5S", ["SEIRI · Utilização", "SEITON · Organização", "SEISO · Limpeza", "SEIKETSU · Saúde", "SHITSUKE · Disciplina"], h);
  });

  // ---- Teto (forro modular) ----------------------------------------------
  const ceil = MeshBuilder.CreateGround("teto", { width: W, height: D }, scene);
  ceil.position.set(cx, H, cz);
  ceil.rotation.x = Math.PI; // face para baixo
  ceil.material = unlit(scene, "teto", paintTexture(scene, "teto", W, D, 40, ceilingTiles));
  out.push(ceil);

  // ---- Mobiliário e máquinas (primitivas fundidas por material) -----------
  const groups: Record<string, { color: Color3; spec?: number; glow?: boolean; parts: Mesh[] }> = {
    grafite: { color: c3("#2a2f35"), parts: [] },
    aco: { color: c3("#8b9299"), spec: 0.35, parts: [] },
    maquina: { color: c3("#5d7466"), spec: 0.2, parts: [] }, // verde-máquina clássico
    vermelho: { color: c3("#a3262a"), spec: 0.25, parts: [] },
    azul: { color: c3("#3f5e80"), spec: 0.15, parts: [] },
    amarelo: { color: c3("#d4a106"), parts: [] },
    tampo: { color: c3("#4c5258"), parts: [] },
    caixa: { color: c3("#3b6ea8"), parts: [] },
    luz: { color: c3("#fffaf0"), glow: true, parts: [] },
    tela: { color: c3("#3fa0e0"), glow: true, parts: [] },
  };
  const box = (g: string, w: number, h: number, d: number, x: number, y: number, z: number, ry = 0): void => {
    const m = MeshBuilder.CreateBox("lab_" + g, { width: w, height: h, depth: d }, scene);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    groups[g].parts.push(m);
  };
  const cyl = (g: string, dia: number, h: number, x: number, y: number, z: number, axis: "x" | "y" | "z" = "y"): void => {
    const m = MeshBuilder.CreateCylinder("lab_" + g, { diameter: dia, height: h, tessellation: 18 }, scene);
    m.position.set(x, y, z);
    if (axis === "x") m.rotation.z = Math.PI / 2;
    if (axis === "z") m.rotation.x = Math.PI / 2;
    groups[g].parts.push(m);
  };

  // Luminárias de LED embutidas no forro (2 fileiras).
  for (const x of [-3, 0, 3]) {
    for (const z of [-1.2, 1.4, 3.8]) {
      box("grafite", 1.26, 0.03, 0.66, x, H - 0.012, z);
      box("luz", 1.2, 0.02, 0.6, x, H - 0.03, z);
    }
  }
  // Eletrocalha ao longo do teto.
  box("aco", W - 0.4, 0.06, 0.25, cx, H - 0.35, 2.6);

  // Bancada de parede com morsas (fundo, à esquerda do painel de ferramentas).
  const benchY = 0.9;
  wallBench(0, LAB.maxZ - 0.42, 3.6);
  for (const x of [-1.4, -0.3]) vise(x, LAB.maxZ - 0.5, benchY);
  // Furadeira de coluna sobre a bancada de parede.
  drillPress(1.2, LAB.maxZ - 0.4);

  // Carro de ferramentas vermelho (gavetas) e armário alto.
  toolChest(-3.6, LAB.maxZ - 0.4);
  box("aco", 0.9, 1.95, 0.5, 4.6, 0.975, LAB.maxZ - 0.3); // armário de aço
  box("grafite", 0.004, 1.85, 0.02, 4.6, 0.975, LAB.maxZ - 0.55); // junta das portas
  box("grafite", 0.02, 0.12, 0.03, 4.55, 1.0, LAB.maxZ - 0.56); // puxador
  box("grafite", 0.02, 0.12, 0.03, 4.65, 1.0, LAB.maxZ - 0.56);

  // Torno mecânico na parede esquerda.
  lathe(LAB.minX + 0.75, 1.4);
  // Fresadora na parede direita, com painel CNC.
  mill(LAB.maxX - 0.8, 1.5);

  // Estante de aço com caixas organizadoras (direita, perto da frente).
  shelving(LAB.maxX - 0.35, 3.7);
  // Armários (lockers) atrás do operador.
  lockers(-2.9, LAB.minZ + 0.3);
  // Extintor e lixeiras de coleta seletiva.
  extinguisher(LAB.maxX - 0.15, LAB.maxZ - 6.4);
  for (const [i, col] of (["azul", "vermelho", "amarelo"] as const).entries()) {
    cyl(col, 0.4, 0.62, -0.5 + i * 0.5, 0.31, LAB.minZ + 0.32);
  }

  // Faixas de circulação no piso (amarelo).
  const lane = (w: number, d: number, x: number, z: number): void => box("amarelo", w, 0.003, d, x, 0.0018, z);
  lane(0.08, D - 1.8, LAB.minX + 1.75, cz); // à frente do torno
  lane(0.08, D - 1.8, LAB.maxX - 1.75, cz); // à frente da fresadora
  lane(W - 3.5, 0.08, cx, LAB.maxZ - 1.15); // ao longo da parede do fundo

  for (const [name, g] of Object.entries(groups)) {
    if (!g.parts.length) continue;
    const merged = Mesh.MergeMeshes(g.parts, true, true);
    if (!merged) continue;
    merged.name = "lab_" + name;
    const mat = new StandardMaterial("lab_" + name + "_mat", scene);
    if (g.glow) {
      mat.disableLighting = true;
      mat.emissiveColor = g.color;
    } else {
      mat.diffuseColor = g.color;
      mat.specularColor = new Color3(1, 1, 1).scale(g.spec ?? 0.08);
      mat.specularPower = 48;
      mat.ambientColor = g.color.scale(0.3);
    }
    merged.material = mat;
    out.push(merged);
  }

  for (const m of out) {
    m.isPickable = false;
    m.receiveShadows = false;
    m.freezeWorldMatrix();
    m.doNotSyncBoundingInfo = true;
    m.material?.freeze();
  }
  return out;

  // ---------------------------------------------------------- peças compostas
  function wallBench(x: number, z: number, len: number): void {
    box("tampo", len, 0.05, 0.75, x, benchY - 0.025, z);
    for (const sx of [-1, 1]) {
      box("grafite", 0.05, benchY - 0.05, 0.05, x + sx * (len / 2 - 0.05), (benchY - 0.05) / 2, z - 0.3);
      box("grafite", 0.05, benchY - 0.05, 0.05, x + sx * (len / 2 - 0.05), (benchY - 0.05) / 2, z + 0.3);
    }
    box("grafite", len - 0.1, 0.03, 0.6, x, 0.2, z); // prateleira inferior
    box("caixa", 0.4, 0.18, 0.3, x - 0.8, 0.31, z);
    box("vermelho", 0.45, 0.2, 0.25, x + 0.6, 0.32, z); // maleta
  }
  function vise(x: number, z: number, y: number): void {
    box("azul", 0.14, 0.06, 0.2, x, y + 0.03, z);
    box("azul", 0.14, 0.09, 0.05, x, y + 0.1, z - 0.07);
    box("azul", 0.14, 0.09, 0.05, x, y + 0.1, z + 0.02);
    cyl("aco", 0.016, 0.22, x, y + 0.09, z - 0.18, "z");
  }
  function drillPress(x: number, z: number): void {
    const y = benchY;
    box("maquina", 0.32, 0.04, 0.45, x, y + 0.02, z); // base
    cyl("aco", 0.07, 0.95, x, y + 0.5, z + 0.12); // coluna
    box("maquina", 0.2, 0.18, 0.4, x, y + 0.85, z - 0.02); // cabeçote
    box("maquina", 0.18, 0.08, 0.2, x, y + 0.98, z + 0.1); // motor
    cyl("grafite", 0.05, 0.12, x, y + 0.7, z - 0.13); // mandril
    box("aco", 0.22, 0.02, 0.22, x, y + 0.42, z - 0.08); // mesa
    cyl("aco", 0.012, 0.22, x + 0.12, y + 0.82, z - 0.05, "x"); // alavanca
  }
  function toolChest(x: number, z: number): void {
    box("vermelho", 0.8, 0.95, 0.5, x, 0.55, z);
    box("vermelho", 0.8, 0.4, 0.45, x, 1.25, z + 0.02);
    for (let i = 0; i < 6; i++) box("aco", 0.6, 0.012, 0.01, x, 0.25 + i * 0.13, z - 0.255); // puxadores
    for (let i = 0; i < 2; i++) box("aco", 0.6, 0.012, 0.01, x, 1.15 + i * 0.15, z - 0.235);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) cyl("grafite", 0.07, 0.04, x + sx * 0.33, 0.04, z + sz * 0.18, "x");
    box("tampo", 0.82, 0.02, 0.52, x, 1.035, z);
  }
  function lathe(x: number, z: number): void {
    box("maquina", 0.55, 0.75, 2.2, x, 0.375, z); // base/gabinete
    box("tampo", 0.6, 0.04, 2.3, x, 0.77, z); // bandeja de cavacos
    box("aco", 0.3, 0.12, 2.0, x, 0.86, z); // barramento
    box("maquina", 0.45, 0.45, 0.5, x, 1.1, z - 0.85); // cabeçote fixo
    cyl("aco", 0.22, 0.1, x + 0.0, 1.07, z - 0.55, "z"); // placa (mandril)
    box("maquina", 0.25, 0.25, 0.3, x, 1.02, z + 0.8); // cabeçote móvel
    box("maquina", 0.32, 0.12, 0.3, x, 0.98, z + 0.05); // carro
    box("aco", 0.12, 0.08, 0.08, x + 0.05, 1.08, z + 0.05); // porta-ferramentas
    box("grafite", 0.12, 0.3, 0.2, x + 0.33, 1.1, z - 0.85); // painel
    box("amarelo", 0.05, 0.05, 0.02, x + 0.4, 1.15, z - 0.85); // emergência
  }
  function mill(x: number, z: number): void {
    box("maquina", 0.7, 1.1, 0.7, x + 0.05, 0.55, z); // coluna/base
    box("maquina", 0.5, 0.6, 0.9, x + 0.05, 1.4, z); // corpo
    box("maquina", 0.4, 0.35, 0.5, x - 0.35, 1.55, z); // cabeçote
    cyl("aco", 0.08, 0.25, x - 0.4, 1.25, z); // árvore
    box("aco", 0.5, 0.06, 1.3, x - 0.4, 0.92, z); // mesa
    box("maquina", 0.4, 0.2, 0.5, x - 0.4, 0.8, z); // sela
    box("grafite", 0.08, 0.5, 0.42, x - 0.3, 1.55, z - 0.75); // painel CNC
    box("tela", 0.01, 0.22, 0.3, x - 0.345, 1.65, z - 0.75); // tela
    box("vermelho", 0.02, 0.05, 0.05, x - 0.345, 1.38, z - 0.68);
  }
  function shelving(x: number, z: number): void {
    const len = 1.8;
    for (const sz of [-1, 1]) {
      box("aco", 0.04, 2.0, 0.04, x - 0.2, 1.0, z + sz * (len / 2));
      box("aco", 0.04, 2.0, 0.04, x + 0.2, 1.0, z + sz * (len / 2));
    }
    const colors = ["caixa", "vermelho", "amarelo", "caixa"];
    for (let i = 0; i < 5; i++) {
      const y = 0.12 + i * 0.45;
      box("aco", 0.45, 0.025, len, x, y, z);
      if (i === 4) continue;
      for (let k = 0; k < 4; k++) {
        if ((i + k) % 3 === 2) continue; // vãos
        box(colors[(i + k) % 4], 0.35, 0.22, 0.34, x, y + 0.125, z - 0.65 + k * 0.43);
      }
    }
  }
  function lockers(x: number, z: number): void {
    for (let i = 0; i < 4; i++) {
      const lx = x + i * 0.42;
      box("azul", 0.4, 1.8, 0.45, lx, 0.9, z);
      box("grafite", 0.03, 0.1, 0.01, lx + 0.13, 1.0, z + 0.23);
      for (let k = 0; k < 3; k++) box("grafite", 0.25, 0.01, 0.01, lx, 1.55 + k * 0.04, z + 0.23); // ventilação
    }
  }
  function extinguisher(x: number, z: number): void {
    box("vermelho", 0.02, 0.5, 0.5, x + 0.1, 1.45, z); // placa
    cyl("vermelho", 0.17, 0.5, x - 0.05, 0.62, z);
    cyl("grafite", 0.05, 0.08, x - 0.05, 0.91, z);
    box("grafite", 0.12, 0.02, 0.03, x - 0.07, 0.96, z);
  }
}

// ======================================================================
//                         TEXTURAS PINTADAS (canvas)
// ======================================================================

function c3(hex: string): Color3 {
  return Color3.FromHexString(hex);
}

function unlit(scene: Scene, name: string, tex: DynamicTexture): StandardMaterial {
  const m = new StandardMaterial(name + "_mat", scene);
  m.disableLighting = true;
  m.emissiveTexture = tex;
  return m;
}

function paintTexture(scene: Scene, name: string, w: number, h: number, ppm: number, paint: Painter): DynamicTexture {
  const px = Math.min(2048, Math.round(w * ppm));
  const py = Math.min(2048, Math.round(h * ppm));
  const tex = new DynamicTexture(name + "_tex", { width: px, height: py }, scene, true);
  const c = tex.getContext() as Ctx;
  // Coordenadas em METROS a partir do canto inferior esquerdo (y para cima).
  c.save();
  c.scale(px / w, py / h);
  paint(c, 1, w, h);
  c.restore();
  tex.update(true);
  tex.anisotropicFilteringLevel = 4;
  tex.wrapU = tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  return tex;
}

/** y em metros a partir do piso → y do canvas (que cresce para baixo). */
const Y = (h: number, y: number): number => h - y;

function baseWall(c: Ctx, _p: number, w: number, h: number): void {
  // Parte superior clara, iluminada de cima; barrado inferior mais escuro.
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#5f666d");
  g.addColorStop(0.25, "#8a9198");
  g.addColorStop(0.62, "#7d848b");
  g.addColorStop(1, "#6a7178");
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  // Barrado (1,1 m) em grafite azulado + friso.
  const b = c.createLinearGradient(0, Y(h, 1.1), 0, h);
  b.addColorStop(0, "#3d4752");
  b.addColorStop(1, "#2b333b");
  c.fillStyle = b;
  c.fillRect(0, Y(h, 1.1), w, 1.1);
  c.fillStyle = "#c9961a";
  c.fillRect(0, Y(h, 1.12), w, 0.03);
  // Rodapé.
  c.fillStyle = "#1c2126";
  c.fillRect(0, Y(h, 0.1), w, 0.1);
  // Escurece os cantos (oclusão "pintada").
  for (const [x0, x1] of [[0, 0.5], [w, w - 0.5]]) {
    const s = c.createLinearGradient(x0, 0, x1, 0);
    s.addColorStop(0, "rgba(0,0,0,0.35)");
    s.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = s;
    c.fillRect(Math.min(x0, x1), 0, 0.5, h);
  }
  const top = c.createLinearGradient(0, 0, 0, 0.4);
  top.addColorStop(0, "rgba(0,0,0,0.35)");
  top.addColorStop(1, "rgba(0,0,0,0)");
  c.fillStyle = top;
  c.fillRect(0, 0, w, 0.4);
}

/** Faixa de janelas altas (basculantes) com céu e prédios ao fundo. */
function windowsBand(c: Ctx, _p: number, spans: number[][], h: number): void {
  const y0 = 2.15;
  const y1 = 3.2;
  for (const [x, len] of spans) {
    const top = Y(h, y1);
    const ht = y1 - y0;
    const sky = c.createLinearGradient(0, top, 0, top + ht);
    sky.addColorStop(0, "#a9cdea");
    sky.addColorStop(0.7, "#d8e8f3");
    sky.addColorStop(1, "#eef3f6");
    c.fillStyle = sky;
    c.fillRect(x, top, len, ht);
    // Prédios / árvores distantes.
    let seed = Math.round(x * 100) + 7;
    const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let bx = x; bx < x + len; ) {
      const bw = 0.25 + rnd() * 0.5;
      const bh = 0.15 + rnd() * 0.45;
      c.fillStyle = rnd() > 0.35 ? "#93a6b6" : "#7f9a86";
      c.fillRect(bx, top + ht - bh, Math.min(bw, x + len - bx), bh);
      bx += bw;
    }
    // Reflexo diagonal no vidro.
    c.fillStyle = "rgba(255,255,255,0.12)";
    c.beginPath();
    c.moveTo(x + len * 0.15, top);
    c.lineTo(x + len * 0.35, top);
    c.lineTo(x + len * 0.15, top + ht);
    c.lineTo(x, top + ht);
    c.closePath();
    c.fill();
    // Caixilhos.
    c.strokeStyle = "#3a4047";
    c.lineWidth = 0.06;
    c.strokeRect(x, top, len, ht);
    c.lineWidth = 0.035;
    const n = Math.max(2, Math.round(len / 0.9));
    for (let i = 1; i < n; i++) {
      c.beginPath();
      c.moveTo(x + (len * i) / n, top);
      c.lineTo(x + (len * i) / n, top + ht);
      c.stroke();
    }
    c.beginPath();
    c.moveTo(x, top + ht * 0.45);
    c.lineTo(x + len, top + ht * 0.45);
    c.stroke();
    // Peitoril.
    c.fillStyle = "#4a5158";
    c.fillRect(x - 0.05, top + ht, len + 0.1, 0.05);
  }
}

/** Painel perfurado com silhuetas das ferramentas (sombra pintada). */
function pegboard(c: Ctx, _p: number, x: number, y: number, w: number, hh: number, h: number): void {
  const top = Y(h, y + hh);
  c.fillStyle = "#b39b74";
  c.fillRect(x, top, w, hh);
  c.fillStyle = "rgba(60,45,25,0.55)";
  for (let px = x + 0.05; px < x + w; px += 0.05) for (let py = top + 0.05; py < top + hh; py += 0.05) c.fillRect(px, py, 0.008, 0.008);
  c.strokeStyle = "#5d4b33";
  c.lineWidth = 0.03;
  c.strokeRect(x, top, w, hh);
  /** Desenha a ferramenta duas vezes: sombra deslocada e depois a cor. */
  const tool = (fn: (col: (s: string) => void) => void): void => {
    c.save();
    c.translate(0.012, 0.015);
    fn(() => (c.fillStyle = "rgba(0,0,0,0.35)"));
    c.restore();
    fn((s) => (c.fillStyle = s));
  };
  // Chaves combinadas (tamanhos crescentes).
  for (let i = 0; i < 7; i++) {
    const tx = x + 0.2 + i * 0.09;
    const len = 0.22 + i * 0.03;
    tool((col) => {
      col("#aab2ba");
      c.fillRect(tx - 0.008, top + 0.12, 0.016, len);
      c.beginPath();
      c.arc(tx, top + 0.12, 0.025, 0, Math.PI * 2);
      c.fill();
    });
  }
  // Martelo.
  tool((col) => {
    col("#7a4a22");
    c.fillRect(x + 1.0, top + 0.18, 0.03, 0.4);
    col("#40464d");
    c.fillRect(x + 0.94, top + 0.13, 0.15, 0.06);
  });
  // Alicates e chaves de fenda.
  for (let i = 0; i < 5; i++) {
    const tx = x + 1.3 + i * 0.12;
    tool((col) => {
      col(["#c0392b", "#f1c40f", "#2e86c1", "#c0392b", "#27ae60"][i]);
      c.fillRect(tx - 0.015, top + 0.15, 0.03, 0.11);
      col("#b8bfc6");
      c.fillRect(tx - 0.004, top + 0.26, 0.008, 0.16);
    });
  }
  // Paquímetro e esquadro.
  tool((col) => {
    col("#c9d0d6");
    c.fillRect(x + 2.0, top + 0.15, 0.4, 0.035);
    c.fillRect(x + 2.0, top + 0.15, 0.02, 0.1);
    c.fillRect(x + 2.08, top + 0.15, 0.02, 0.09);
  });
  tool((col) => {
    col("#c9d0d6");
    c.fillRect(x + 2.6, top + 0.15, 0.3, 0.025);
    c.fillRect(x + 2.6, top + 0.15, 0.025, 0.25);
  });
  // Brocas (indexador).
  tool((col) => {
    col("#2f3a45");
    c.fillRect(x + 2.0, top + 0.55, 0.6, 0.18);
  });
  c.fillStyle = "#c8ccd0";
  for (let i = 0; i < 13; i++) c.fillRect(x + 2.04 + i * 0.042, top + 0.5 - i * 0.004, 0.008, 0.07 + i * 0.004);
  // Rótulo.
  label(c, x + w / 2, top + hh - 0.08, "FERRAMENTAS — DEVOLVA AO LUGAR", 0.07, "#3a2c19");
}

function banner(c: Ctx, _p: number, x: number, y: number, text: string, h: number): void {
  const top = Y(h, y + 0.3);
  c.fillStyle = "#1f3a5c";
  c.fillRect(x - 1.8, top, 3.6, 0.3);
  c.fillStyle = "#c9961a";
  c.fillRect(x - 1.8, top + 0.27, 3.6, 0.03);
  label(c, x, top + 0.15, text, 0.15, "#f2f4f6");
}

function mandatory(c: Ctx, _p: number, x: number, y: number, text: string, h: number): void {
  const top = Y(h, y + 0.62);
  c.fillStyle = "#f4f6f8";
  c.fillRect(x - 0.24, top, 0.48, 0.62);
  c.fillStyle = "#1460aa";
  c.beginPath();
  c.arc(x, top + 0.22, 0.17, 0, Math.PI * 2);
  c.fill();
  // Pictograma simples: óculos / abafador.
  c.strokeStyle = "#ffffff";
  c.lineWidth = 0.025;
  c.beginPath();
  c.arc(x - 0.06, top + 0.23, 0.045, 0, Math.PI * 2);
  c.arc(x + 0.06, top + 0.23, 0.045, 0, Math.PI * 2);
  c.stroke();
  c.beginPath();
  c.moveTo(x - 0.015, top + 0.22);
  c.lineTo(x + 0.015, top + 0.22);
  c.stroke();
  label(c, x, top + 0.5, text, 0.06, "#1460aa");
}

function warning(c: Ctx, _p: number, x: number, y: number, text: string, h: number): void {
  const top = Y(h, y + 0.62);
  c.fillStyle = "#f4f6f8";
  c.fillRect(x - 0.27, top, 0.54, 0.62);
  c.fillStyle = "#f2c200";
  c.strokeStyle = "#111";
  c.lineWidth = 0.025;
  c.beginPath();
  c.moveTo(x, top + 0.05);
  c.lineTo(x + 0.2, top + 0.39);
  c.lineTo(x - 0.2, top + 0.39);
  c.closePath();
  c.fill();
  c.stroke();
  label(c, x, top + 0.27, "!", 0.2, "#111");
  label(c, x, top + 0.51, text, 0.055, "#111");
}

function fireSign(c: Ctx, _p: number, x: number, y: number, h: number): void {
  const top = Y(h, y + 0.45);
  c.fillStyle = "#c62828";
  c.fillRect(x - 0.22, top, 0.44, 0.45);
  label(c, x, top + 0.17, "EXTINTOR", 0.07, "#fff");
  label(c, x, top + 0.3, "ABC", 0.09, "#fff");
}

function notice(c: Ctx, _p: number, x: number, y: number, title: string, lines: string[], h: number): void {
  const hh = 0.28 + lines.length * 0.1;
  const top = Y(h, y + hh);
  c.fillStyle = "rgba(0,0,0,0.3)";
  c.fillRect(x - 0.42, top + 0.03, 0.88, hh);
  c.fillStyle = "#eef1f4";
  c.fillRect(x - 0.45, top, 0.9, hh);
  c.fillStyle = "#1f3a5c";
  c.fillRect(x - 0.45, top, 0.9, 0.16);
  label(c, x, top + 0.08, title, 0.07, "#fff");
  lines.forEach((t, i) => write(c, x - 0.38, top + 0.27 + i * 0.1, t, 0.06, "#26303a", "600", "left"));
}

function whiteboard(c: Ctx, _p: number, x: number, y: number, w: number, hh: number, h: number): void {
  const top = Y(h, y + hh);
  c.fillStyle = "#9aa1a8";
  c.fillRect(x - 0.04, top - 0.04, w + 0.08, hh + 0.12);
  c.fillStyle = "#f5f7f8";
  c.fillRect(x, top, w, hh);
  const hand = (t: string, y: number, col: string): void => write(c, x + 0.15, top + y, t, 0.075, col, "italic 600", "left");
  hand("v = π · D · n / 1000", 0.2, "#1d4f91");
  hand("n = 1000 · v / (π · D)", 0.36, "#b22222");
  hand("Aço 1020 → v ≈ 25 m/min", 0.52, "#23303b");
  hand("Broca Ø6 → n ≈ 1300 rpm", 0.66, "#23303b");
  // Esboço de broca.
  c.strokeStyle = "#23303b";
  c.lineWidth = 0.012;
  c.strokeRect(x + 1.55, top + 0.2, 0.5, 0.1);
  c.beginPath();
  c.moveTo(x + 2.05, top + 0.2);
  c.lineTo(x + 2.2, top + 0.25);
  c.lineTo(x + 2.05, top + 0.3);
  c.stroke();
  c.fillStyle = "#6b7680";
  c.fillRect(x + 0.2, top + hh - 0.03, 0.5, 0.03); // apagador
}

function door(c: Ctx, _p: number, x: number, h: number): void {
  const top = Y(h, 2.15);
  c.fillStyle = "#2a3036";
  c.fillRect(x - 0.06, top - 0.06, 1.12, 2.21);
  const g = c.createLinearGradient(x, 0, x + 1, 0);
  g.addColorStop(0, "#56606a");
  g.addColorStop(1, "#4a535c");
  c.fillStyle = g;
  c.fillRect(x, top, 1.0, 2.15);
  c.fillStyle = "#c3d6e4";
  c.fillRect(x + 0.35, top + 0.25, 0.3, 0.55); // visor
  c.fillStyle = "#b8bec4";
  c.fillRect(x + 0.82, top + 1.05, 0.12, 0.03); // maçaneta
  c.fillStyle = "#2e7d32";
  c.fillRect(x + 0.2, top - 0.3, 0.6, 0.2);
  label(c, x + 0.5, top - 0.2, "SAÍDA", 0.11, "#fff");
}

function electricalPanel(c: Ctx, _p: number, x: number, y: number, h: number): void {
  const top = Y(h, y + 0.9);
  c.fillStyle = "rgba(0,0,0,0.35)";
  c.fillRect(x + 0.03, top + 0.04, 0.7, 0.9);
  c.fillStyle = "#a7adb3";
  c.fillRect(x, top, 0.7, 0.9);
  c.strokeStyle = "#6f767c";
  c.lineWidth = 0.012;
  c.strokeRect(x + 0.04, top + 0.04, 0.62, 0.82);
  c.fillStyle = "#3b4148";
  c.fillRect(x + 0.6, top + 0.4, 0.03, 0.1);
  c.fillStyle = "#f2c200";
  c.fillRect(x + 0.2, top + 0.12, 0.3, 0.1);
  label(c, x + 0.35, top + 0.17, "QDF-01", 0.06, "#111");
}

function clock(c: Ctx, _p: number, x: number, y: number, h: number): void {
  const cy = Y(h, y);
  c.fillStyle = "#20252a";
  c.beginPath();
  c.arc(x, cy, 0.17, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = "#f4f5f6";
  c.beginPath();
  c.arc(x, cy, 0.15, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = "#20252a";
  c.lineWidth = 0.01;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    c.beginPath();
    c.moveTo(x + Math.sin(a) * 0.12, cy - Math.cos(a) * 0.12);
    c.lineTo(x + Math.sin(a) * 0.14, cy - Math.cos(a) * 0.14);
    c.stroke();
  }
  c.lineWidth = 0.014;
  c.beginPath();
  c.moveTo(x, cy);
  c.lineTo(x + 0.06, cy - 0.05);
  c.moveTo(x, cy);
  c.lineTo(x - 0.02, cy - 0.11);
  c.stroke();
}

function ceilingTiles(c: Ctx, _p: number, w: number, h: number): void {
  c.fillStyle = "#b4b9be";
  c.fillRect(0, 0, w, h);
  // Placas de 0,625 m com perfil "T".
  c.strokeStyle = "#8e959b";
  c.lineWidth = 0.03;
  for (let x = 0; x <= w; x += 0.625) {
    c.beginPath();
    c.moveTo(x, 0);
    c.lineTo(x, h);
    c.stroke();
  }
  for (let y = 0; y <= h; y += 0.625) {
    c.beginPath();
    c.moveTo(0, y);
    c.lineTo(w, y);
    c.stroke();
  }
  // Mais escuro nas bordas (longe das luminárias).
  const g = c.createRadialGradient(w / 2, h / 2, 1, w / 2, h / 2, Math.max(w, h) * 0.7);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,0.45)");
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
}

function label(c: Ctx, x: number, y: number, text: string, size: number, color: string): void {
  write(c, x, y, text, size, color, "700", "center", "middle");
}

/**
 * Texto em PIXELS reais: o canvas está em escala de metros e fontes com
 * tamanho fracionário (0,06 px) são arredondadas por alguns navegadores.
 */
function write(c: Ctx, x: number, y: number, text: string, size: number, color: string, weight: string, align: CanvasTextAlign, base: CanvasTextBaseline = "alphabetic"): void {
  const t = c.getTransform();
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = color;
  c.font = `${weight} ${Math.max(6, Math.round(size * t.d))}px "Segoe UI", Arial, sans-serif`;
  c.textAlign = align;
  c.textBaseline = base;
  c.fillText(text, t.a * x + t.e, t.d * y + t.f);
  c.restore();
}

import { type AbstractMesh, Color3, type Material, type Node, PBRMaterial, type Scene } from "@babylonjs/core";
import type { LoadedModel } from "./modelLoader";

/**
 * Apresentação dos materiais do CAD — SEM alterar a geometria.
 *
 * O SolidWorks exporta "aparências" (brushedbronze, polishedsteel…) e usa
 * "defaultplastic" (azul-acinzentado brilhante) como padrão para qualquer
 * peça sem aparência atribuída — inclusive eixos, engrenagens e pinos de aço.
 * Aqui cada peça recebe um material físico coerente com sua função.
 *
 * Regras de PBR seguidas (para não "lavar" o modelo de branco):
 *  - metallic = 1 só em metais reais; plásticos/pinturas ficam em 0;
 *  - rugosidade nunca abaixo de ~0,2 (evita espelhos);
 *  - cores de aparências reais (bronze, aço) são preservadas.
 */
interface Preset {
  albedo: [number, number, number];
  metallic: number;
  roughness: number;
  alpha?: number;
  env?: number;
}

export const PRESETS: Record<string, Preset> = {
  /** Aço usinado (eixos, engrenagens, pinos). */
  acoUsinado: { albedo: [0.6, 0.61, 0.63], metallic: 1, roughness: 0.34 },
  /** Aço polido/cromado (mandril, castanhas). */
  acoPolido: { albedo: [0.74, 0.74, 0.75], metallic: 1, roughness: 0.2 },
  /** Aço escovado / inox acetinado (parafusos, cabos). */
  acoEscovado: { albedo: [0.66, 0.65, 0.63], metallic: 1, roughness: 0.38 },
  /** Bronze de mancal. */
  bronze: { albedo: [0.8, 0.52, 0.32], metallic: 1, roughness: 0.36 },
  /** Ferro fundido / aço oxidado preto (coroa, pinhão). */
  ferroOxidado: { albedo: [0.12, 0.12, 0.13], metallic: 0.85, roughness: 0.5 },
  /** Alumínio anodizado escovado (braço da manivela). */
  aluminioEscovado: { albedo: [0.78, 0.8, 0.83], metallic: 1, roughness: 0.42 },
  /** Alumínio fosco (encosto). */
  aluminioFosco: { albedo: [0.72, 0.74, 0.76], metallic: 1, roughness: 0.55 },
  /** Polímero técnico branco (punhos). */
  polimeroBranco: { albedo: [0.82, 0.82, 0.8], metallic: 0, roughness: 0.48 },
  /** Polímero/borracha preta (botões, anéis). */
  polimeroPreto: { albedo: [0.05, 0.05, 0.055], metallic: 0, roughness: 0.62 },
  /** Carcaça em acrílico transparente (mostra o mecanismo interno). */
  acrilico: { albedo: [0.92, 0.95, 1], metallic: 0, roughness: 0.08, alpha: 0.16, env: 1 },
};

/** Regra por NOME DA PEÇA (o primeiro ancestral que casar vence). */
const PART_RULES: Array<[RegExp, keyof typeof PRESETS]> = [
  [/CORPO DE ALUMINIO|^TAMPA-/i, "acrilico"],
  [/castanha|CONE DE AJUSTE|MOLA|CAPA DO MANDRIL/i, "acoPolido"],
  [/CORPO ROSCADO|EIXO DO MANDRIL/i, "acoPolido"],
  [/COROA|PINHAO/i, "ferroOxidado"],
  [/ENGREN|ENGRENAGEM|EIXO DAS ENGRENAGENS|PINO D /i, "acoUsinado"],
  [/BUCHA/i, "bronze"],
  [/BRAÇO DA MANIVELA/i, "aluminioEscovado"],
  [/ENCOSTO-/i, "aluminioFosco"],
  [/BOTÃO DE APERTO|TRAVA|ANEL DO CABO/i, "polimeroPreto"],
  [/HASTE DE APOIO|PINO ROSCADO|PARAFUSO DO CABO|MANIVELA DO CABO|screw|ARRUELA/i, "acoEscovado"],
];

/** Materiais sem nome ou genéricos dentro de uma peça (2º primitivo etc.). */
const MATERIAL_RULES: Array<[RegExp, keyof typeof PRESETS]> = [
  [/floorwhite/i, "polimeroBranco"],
  [/satinfinish|brushedsteel/i, "acoEscovado"],
];

export function enhanceMaterials(model: LoadedModel, scene: Scene): number {
  const cache = new Map<string, PBRMaterial>();
  const make = (key: keyof typeof PRESETS): PBRMaterial => {
    let m = cache.get(key);
    if (m) return m;
    const p = PRESETS[key];
    m = new PBRMaterial(`apresentacao_${key}`, scene);
    m.albedoColor = new Color3(...p.albedo);
    m.metallic = p.metallic;
    m.roughness = p.roughness;
    m.environmentIntensity = p.env ?? 0.9;
    if (p.alpha !== undefined) {
      m.alpha = p.alpha;
      m.transparencyMode = PBRMaterial.MATERIAL_ALPHABLEND;
      m.backFaceCulling = false;
      m.separateCullingPass = true;
      m.specularIntensity = 1;
    }
    cache.set(key, m);
    return m;
  };

  let changed = 0;
  for (const mesh of model.meshes) {
    const key = pickPreset(mesh);
    if (!key) continue;
    mesh.material = make(key);
    changed++;
  }
  console.info(`[materiais] ${changed} malhas com material de apresentação (${cache.size} materiais compartilhados).`);
  return changed;
}

function pickPreset(mesh: AbstractMesh): keyof typeof PRESETS | null {
  const matName = (mesh.material as Material | null)?.name ?? "";
  // Cabos com várias partes: o primitivo "floorwhite" é o punho branco.
  for (const [re, key] of MATERIAL_RULES) if (re.test(matName) && key === "polimeroBranco") return key;
  for (let n: Node | null = mesh; n; n = n.parent) {
    const name = n.name.replace(/_primitive\d+$/, "");
    for (const [re, key] of PART_RULES) if (re.test(name)) return key;
  }
  for (const [re, key] of MATERIAL_RULES) if (re.test(matName)) return key;
  return null;
}

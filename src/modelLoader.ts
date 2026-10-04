import { AbstractMesh, Mesh, Node, Scene, SceneLoader, TransformNode, Vector3 } from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import { MODEL } from "./config";

export interface LoadedModel {
  /** Nó "__root__" criado pelo loader glTF (faz a conversão de lateralidade). */
  root: AbstractMesh;
  /** Somente meshes com geometria (descarta nós vazios). */
  meshes: AbstractMesh[];
  /** Nome do nó no GLB → nó Babylon (primeira ocorrência). */
  nodesByName: Map<string, TransformNode>;
}

/**
 * Carrega o GLB com SceneLoader, preservando materiais, texturas e geometria.
 * `onProgress` recebe 0..1 (ou −1 se o servidor não informar o tamanho).
 */
export async function loadModel(
  scene: Scene,
  url: string,
  onProgress?: (fraction: number) => void,
): Promise<LoadedModel> {
  const slash = url.lastIndexOf("/") + 1;
  const camerasBefore = new Set(scene.cameras);

  const result = await SceneLoader.ImportMeshAsync(
    "",
    url.slice(0, slash),
    url.slice(slash),
    scene,
    (evt) => onProgress?.(evt.lengthComputable && evt.total > 0 ? evt.loaded / evt.total : -1),
    ".glb",
  );

  if (MODEL.removeEmbeddedCamerasAndLights) {
    // O exportador do SolidWorks inclui as vistas (Front, Top, Isometric…) como
    // câmeras e duas luzes direcionais com escala inválida. Não são geometria.
    for (const light of result.lights) disposeWithEmptyParent(light);
    for (const cam of [...scene.cameras]) if (!camerasBefore.has(cam)) disposeWithEmptyParent(cam);
  }

  const root = result.meshes[0];
  const nodesByName = new Map<string, TransformNode>();
  const duplicates = new Set<string>();
  for (const n of root.getDescendants(false)) {
    if (!(n instanceof TransformNode)) continue;
    if (nodesByName.has(n.name)) duplicates.add(n.name);
    else nodesByName.set(n.name, n);
  }
  if (duplicates.size) {
    console.info("[modelo] Nomes repetidos no GLB (usa-se a 1ª ocorrência):", [...duplicates]);
  }

  const meshes = result.meshes.filter((m) => m.getTotalVertices() > 0);
  return { root, meshes, nodesByName };
}

function disposeWithEmptyParent(n: Node): void {
  const parent = n.parent;
  n.dispose();
  if (parent && parent.getChildren().length === 0) parent.dispose();
}

/** Imprime no console a hierarquia completa do modelo. */
export function printHierarchy(root: Node): void {
  const lines: string[] = [];
  const walk = (n: Node, prefix: string, last: boolean, depth: number): void => {
    let info = "";
    if (n instanceof AbstractMesh) {
      const v = n.getTotalVertices();
      info = v > 0 ? `  [mesh · ${v} vértices · material: ${n.material?.name || "—"}]` : "  [nó]";
    } else if (n instanceof TransformNode) {
      info = "  [grupo]";
    }
    lines.push(depth === 0 ? n.name + info : `${prefix}${last ? "└─ " : "├─ "}${n.name}${info}`);
    const children = n.getChildren();
    const childPrefix = depth === 0 ? "" : prefix + (last ? "   " : "│  ");
    children.forEach((c, i) => walk(c, childPrefix, i === children.length - 1, depth + 1));
  };
  walk(root, "", true, 0);
  console.log(
    "%c[modelo] Hierarquia do GLB%c\n" + lines.join("\n"),
    "font-weight:bold;color:#f5a623",
    "",
  );
}

/** Nós cujo nome sugere mandril/broca — ajuda a preencher CHUCK.nodes. */
export function findCandidates(
  model: LoadedModel,
  pattern = /mandril|mandrel|chuck|castanha|broca|drill.?bit|spindle|eixo do/i,
): string[] {
  return [...model.nodesByName.keys()].filter((n) => pattern.test(n));
}

/** Recalcula as matrizes de mundo de toda a cadeia (ancestrais → descendentes). */
export function refreshWorld(node: Node): void {
  const chain: Node[] = [];
  for (let p: Node | null = node; p; p = p.parent) chain.unshift(p);
  for (const n of chain) if (n instanceof TransformNode) n.computeWorldMatrix(true);
  for (const n of node.getDescendants(false)) if (n instanceof TransformNode) n.computeWorldMatrix(true);
}

/** Caixa envolvente (mundo) dos meshes com geometria dentro dos nós dados. */
export function worldBoundsOf(nodes: Node[]): { min: Vector3; max: Vector3 } | null {
  const meshes: AbstractMesh[] = [];
  for (const n of nodes) {
    if (n instanceof AbstractMesh && n.getTotalVertices() > 0) meshes.push(n);
    for (const m of n.getChildMeshes(false)) if (m.getTotalVertices() > 0) meshes.push(m);
  }
  if (!meshes.length) return null;
  return Mesh.MinMax(meshes);
}

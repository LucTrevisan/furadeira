import {
  ArcRotateCamera,
  Color3,
  Color4,
  DefaultRenderingPipeline,
  DirectionalLight,
  DynamicTexture,
  Engine,
  HemisphericLight,
  ImageProcessingConfiguration,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Scene,
  ShadowGenerator,
  SSAO2RenderingPipeline,
  StandardMaterial,
  Texture,
  Vector3,
} from "@babylonjs/core";
import { SCENE, VISUAL } from "./config";
import { buildLabRoom, LAB } from "./labRoom";

export interface SceneContext {
  scene: Scene;
  camera: ArcRotateCamera;
  ground: Mesh;
  tableTopY: number;
  sun: DirectionalLight;
  shadows: ShadowGenerator | null;
}

/**
 * Ambiente de laboratório de manufatura: sala grafite discreta, piso
 * industrial, bancada técnica e iluminação de estúdio de produto
 * (key + fill + rim + ambiente/IBL). Tudo procedural: sem arquivos extras.
 */
export function createScene(engine: Engine, canvas: HTMLCanvasElement): SceneContext {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.075, 0.085, 0.095, 1);
  scene.skipPointerMovePicking = true; // o "hover" é feito sob demanda (componentInspector)

  // Tone mapping de cena (vale também para o VR, que não usa pós-processamento).
  const ip = scene.imageProcessingConfiguration;
  ip.toneMappingEnabled = true;
  ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  ip.exposure = 1.15;
  ip.contrast = 1.12;

  const tableTopY = SCENE.tableHeight;
  const { x: dx, z: dz } = SCENE.drillPosition;

  // ---- Câmera desktop/celular (enquadramento final em main.ts) ----------
  const camera = new ArcRotateCamera("camera", -Math.PI / 2, 1.1, 0.8, new Vector3(dx, tableTopY + 0.08, dz), scene);
  camera.minZ = 0.01; // o modelo é pequeno (≈0,4 m)
  camera.maxZ = 60;
  camera.lowerRadiusLimit = 0.08;
  camera.upperRadiusLimit = 4;
  camera.lowerBetaLimit = 0.2;
  camera.upperBetaLimit = Math.PI * 0.55; // não passa abaixo do tampo
  camera.wheelDeltaPercentage = 0.01;
  camera.pinchDeltaPercentage = 0.004;
  camera.useNaturalPinchZoom = true;
  camera.panningSensibility = 3000;
  camera.inertia = 0.85;
  camera.attachControl(canvas, true);

  // ---- Iluminação de estúdio ---------------------------------------------
  // Ambiente: baixo, levemente frio vindo de cima e quente refletido do piso.
  const hemi = new HemisphericLight("luz_ambiente", new Vector3(0.1, 1, -0.2), scene);
  hemi.intensity = 0.35;
  hemi.diffuse = new Color3(0.9, 0.94, 1);
  hemi.groundColor = new Color3(0.25, 0.23, 0.21);
  hemi.specular = Color3.Black();

  // Key light: frontal-lateral alta, projeta as sombras.
  const sun = new DirectionalLight("luz_principal", new Vector3(-0.45, -1, 0.55).normalize(), scene);
  sun.position = new Vector3(dx + 1.2, tableTopY + 2.4, dz - 1.4);
  sun.intensity = 2.1;
  sun.diffuse = new Color3(1, 0.97, 0.92);
  sun.shadowMinZ = 0.5;
  sun.shadowMaxZ = 5;

  // Fill light: lado oposto, fria e suave, sem sombra (abre as áreas escuras).
  const fill = new DirectionalLight("luz_preenchimento", new Vector3(0.7, -0.45, 0.35).normalize(), scene);
  fill.intensity = 0.55;
  fill.diffuse = new Color3(0.82, 0.9, 1);
  fill.specular = new Color3(0.25, 0.27, 0.3);

  // Rim light: por trás, recorta a silhueta do equipamento contra o fundo.
  const rim = new DirectionalLight("luz_contorno", new Vector3(0.15, -0.35, -1).normalize(), scene);
  rim.intensity = 1.1;
  rim.diffuse = new Color3(1, 0.93, 0.85);

  // Reflexos (IBL): sem ambiente, metais PBR ficam pretos.
  try {
    scene.createDefaultEnvironment({ createSkybox: false, createGround: false });
    scene.environmentIntensity = 0.75;
  } catch (e) {
    console.warn("[cena] Ambiente IBL indisponível; metais podem parecer escuros.", e);
  }

  // ---- Sala: laboratório de usinagem (paredes, máquinas, sinalização) ----
  // VISUAL.labRoom = false volta ao fundo grafite neutro de "estúdio".
  let room: Mesh | null = null;
  if (VISUAL.labRoom) {
    buildLabRoom(scene);
  } else {
    room = MeshBuilder.CreateBox("sala", { width: 16, height: 6, depth: 16, sideOrientation: Mesh.BACKSIDE }, scene);
    room.position.set(dx, 3 - 0.001, dz);
    const roomMat = new StandardMaterial("sala_mat", scene);
    roomMat.disableLighting = true;
    roomMat.emissiveTexture = makeWallTexture(scene);
    roomMat.backFaceCulling = false;
    room.material = roomMat;
  }

  // ---- Piso industrial (concreto selado cinza, rugosidade variável) -------
  // Com o laboratório, o piso acompanha as paredes (o teletransporte do VR
  // não leva o usuário para fora da sala).
  const floor = VISUAL.labRoom
    ? { w: LAB.maxX - LAB.minX, d: LAB.maxZ - LAB.minZ, x: (LAB.minX + LAB.maxX) / 2, z: (LAB.minZ + LAB.maxZ) / 2 }
    : { w: 16, d: 16, x: dx, z: dz };
  const ground = MeshBuilder.CreateGround("piso", { width: floor.w, height: floor.d }, scene);
  ground.position.set(floor.x, 0, floor.z);
  const groundMat = new PBRMaterial("piso_mat", scene);
  groundMat.albedoTexture = makeConcreteTexture(scene, "piso_albedo", false, floor.w / 2, floor.d / 2);
  groundMat.metallicTexture = makeConcreteTexture(scene, "piso_orm", true, floor.w / 2, floor.d / 2);
  groundMat.useRoughnessFromMetallicTextureGreen = true;
  groundMat.useMetallnessFromMetallicTextureBlue = true;
  groundMat.metallic = 0;
  groundMat.roughness = 1;
  groundMat.environmentIntensity = 0.35;
  ground.material = groundMat;
  ground.receiveShadows = true;

  // Faixa de demarcação da área de trabalho (amarelo industrial, discreto).
  const { width, depth } = SCENE.tableSize;
  const lineMat = new PBRMaterial("demarcacao_mat", scene);
  lineMat.albedoColor = new Color3(0.85, 0.62, 0.08);
  lineMat.metallic = 0;
  lineMat.roughness = 0.7;
  const lines: Mesh[] = [];
  const margin = 0.45;
  const w = width + margin * 2;
  const d = depth + margin * 2;
  for (const [lw, ld, x, z] of [
    [w, 0.05, 0, -d / 2],
    [w, 0.05, 0, d / 2],
    [0.05, d, -w / 2, 0],
    [0.05, d, w / 2, 0],
  ] as const) {
    const l = MeshBuilder.CreateGround("demarcacao", { width: lw, height: ld }, scene);
    l.position.set(dx + x, 0.0015, dz + z);
    lines.push(l);
  }
  const frameLine = Mesh.MergeMeshes(lines, true)!;
  frameLine.material = lineMat;

  // ---- Bancada técnica ----------------------------------------------------
  const top = MeshBuilder.CreateBox("bancada_tampo", { width, height: 0.04, depth }, scene);
  top.position.set(dx, tableTopY - 0.02, dz);
  const topMat = new PBRMaterial("bancada_tampo_mat", scene);
  topMat.albedoTexture = makeWorktopTexture(scene);
  topMat.metallic = 0;
  topMat.roughness = 0.62;
  topMat.environmentIntensity = 0.5;
  top.material = topMat;
  top.receiveShadows = true;

  // Borda de aço escovado do tampo.
  const edge = MeshBuilder.CreateBox("bancada_borda", { width: width + 0.012, height: 0.012, depth: depth + 0.012 }, scene);
  edge.position.set(dx, tableTopY - 0.034, dz);
  const steelMat = new PBRMaterial("bancada_aco_mat", scene);
  steelMat.albedoColor = new Color3(0.24, 0.25, 0.27);
  steelMat.metallic = 0.4;
  steelMat.roughness = 0.5;
  steelMat.environmentIntensity = 0.45;
  edge.material = steelMat;

  // Estrutura em tubo pintado grafite (pintura eletrostática).
  const legs: Mesh[] = [];
  const legH = tableTopY - 0.04;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = MeshBuilder.CreateBox("perna", { width: 0.05, height: legH, depth: 0.05 }, scene);
      leg.position.set(dx + sx * (width / 2 - 0.06), legH / 2, dz + sz * (depth / 2 - 0.06));
      legs.push(leg);
    }
    const rail = MeshBuilder.CreateBox("travessa", { width: 0.04, height: 0.04, depth: depth - 0.12 }, scene);
    rail.position.set(dx + sx * (width / 2 - 0.06), 0.18, dz);
    legs.push(rail);
  }
  const shelf = MeshBuilder.CreateBox("travessa", { width: width - 0.12, height: 0.04, depth: 0.04 }, scene);
  shelf.position.set(dx, 0.18, dz + depth / 2 - 0.06);
  legs.push(shelf);
  const frame = Mesh.MergeMeshes(legs, true)!;
  frame.name = "bancada_estrutura";
  const frameMat = new PBRMaterial("bancada_estrutura_mat", scene);
  frameMat.albedoColor = new Color3(0.09, 0.1, 0.11);
  frameMat.metallic = 0.2;
  frameMat.roughness = 0.55;
  frame.material = frameMat;
  frame.receiveShadows = true;

  for (const m of [ground, frameLine, top, edge, frame, ...(room ? [room] : [])]) {
    m.isPickable = m === ground; // o piso é usado pelo teletransporte do VR
    m.freezeWorldMatrix();
    m.material?.freeze();
  }

  // ---- Sombras (estáticas no VR; ver main.ts) ----------------------------
  let shadows: ShadowGenerator | null = null;
  if (VISUAL.shadows) {
    shadows = new ShadowGenerator(1024, sun); // 1024 + PCF médio: bom equilíbrio custo × qualidade
    shadows.usePercentageCloserFiltering = true;
    shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    shadows.bias = 0.0006;
    shadows.normalBias = 0.0025;
    shadows.setDarkness(0.22);
    shadows.transparencyShadow = true;
    shadows.enableSoftTransparentShadow = true;
  }

  return { scene, camera, ground, tableTopY, sun, shadows };
}

/**
 * Pós-processamento do desktop: SSAO2 (sombras de contato entre as peças),
 * MSAA/FXAA e leve nitidez. Ligado só à câmera desktop — no VR a câmera é
 * outra (WebXRCamera) e não paga esse custo.
 */
export function setupDesktopPostProcess(scene: Scene, camera: ArcRotateCamera, modelSize: number): SSAO2RenderingPipeline | null {
  const engine = scene.getEngine() as Engine;
  try {
    const pipe = new DefaultRenderingPipeline("pos_desktop", true, scene, [camera]);
    pipe.samples = 1; // MSAA 4x custava ~60% do quadro; o FXAA já suaviza as bordas
    pipe.fxaaEnabled = true;
    pipe.sharpenEnabled = true;
    pipe.sharpen.edgeAmount = 0.15;
    pipe.bloomEnabled = false;
    pipe.imageProcessingEnabled = true; // usa a configuração de cena (ACES)
  } catch (e) {
    console.warn("[cena] Pós-processamento indisponível:", e);
  }

  if (!VISUAL.ssao || engine.webGLVersion < 2 || !SSAO2RenderingPipeline.IsSupported) return null;
  try {
    const ssao = new SSAO2RenderingPipeline("ssao_desktop", scene, { ssaoRatio: 0.5, blurRatio: 1 }, [camera], true);
    // Escala do efeito proporcional ao equipamento (≈0,4 m).
    ssao.radius = modelSize * 0.06;
    ssao.totalStrength = 1.1;
    ssao.base = 0.12;
    ssao.samples = 16;
    ssao.maxZ = 8;
    ssao.minZAspect = 0.4;
    ssao.expensiveBlur = true;
    return ssao;
  } catch (e) {
    console.warn("[cena] SSAO indisponível:", e);
    return null;
  }
}

/**
 * Sombra de contato falsa (decalque suave) sob o equipamento: garante o
 * "apoio" visual também no VR, onde não há SSAO.
 */
export function addContactShadow(scene: Scene, center: Vector3, sizeX: number, sizeZ: number, y: number): Mesh {
  const plane = MeshBuilder.CreateGround("sombra_contato", { width: sizeX * 1.25, height: sizeZ * 1.6 }, scene);
  plane.position.set(center.x, y + 0.0008, center.z);
  const tex = new DynamicTexture("sombra_contato_tex", { width: 256, height: 256 }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const g = ctx.createRadialGradient(128, 128, 10, 128, 128, 128);
  g.addColorStop(0, "rgba(0,0,0,0.55)");
  g.addColorStop(0.55, "rgba(0,0,0,0.25)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  tex.update();
  tex.hasAlpha = true;
  const mat = new StandardMaterial("sombra_contato_mat", scene);
  mat.diffuseTexture = tex;
  mat.useAlphaFromDiffuseTexture = true;
  mat.disableLighting = true;
  mat.emissiveColor = Color3.Black();
  mat.specularColor = Color3.Black();
  plane.material = mat;
  plane.isPickable = false;
  return plane;
}

// ------------------------------------------------------------- texturas

/** Gradiente vertical grafite com faixa de rodapé e linhas de painel discretas. */
function makeWallTexture(scene: Scene): DynamicTexture {
  const s = 512;
  const tex = new DynamicTexture("sala_tex", { width: s, height: s }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const g = ctx.createLinearGradient(0, 0, 0, s);
  g.addColorStop(0, "#15181c");
  g.addColorStop(0.5, "#252a30");
  g.addColorStop(0.9, "#30363d");
  g.addColorStop(1, "#1a1e22");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  // Juntas verticais de painéis (muito discretas).
  ctx.strokeStyle = "rgba(255,255,255,0.035)";
  ctx.lineWidth = 2;
  for (let x = 0; x <= s; x += s / 4) {
    ctx.beginPath();
    ctx.moveTo(x, s * 0.12);
    ctx.lineTo(x, s * 0.93);
    ctx.stroke();
  }
  // Friso âmbar fino na altura do rodapé.
  ctx.fillStyle = "rgba(245,166,35,0.12)";
  ctx.fillRect(0, s * 0.935, s, 3);
  tex.update();
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.uScale = 4;
  return tex;
}

/**
 * Concreto selado: ruído fino de baixa amplitude + juntas a cada 2 m.
 * `orm`: canal G = rugosidade (0,72–0,92), B = metal (0).
 */
function makeConcreteTexture(scene: Scene, name: string, orm: boolean, uScale: number, vScale: number): DynamicTexture {
  const s = 512;
  const tex = new DynamicTexture(name, { width: s, height: s }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const img = ctx.createImageData(s, s);
  let seed = 1337;
  const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // Ruído de baixa frequência (manchas) + alta frequência (grão).
  const blot: number[] = [];
  for (let i = 0; i < 64; i++) blot.push(rnd());
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const bx = Math.floor((x / s) * 8);
      const by = Math.floor((y / s) * 8);
      const low = blot[(by * 8 + bx) % 64] * 0.5 + blot[((by + 3) * 8 + bx + 5) % 64] * 0.5;
      const grain = rnd();
      const i = (y * s + x) * 4;
      if (orm) {
        img.data[i] = 255;
        img.data[i + 1] = Math.round(255 * (0.72 + low * 0.12 + grain * 0.08));
        img.data[i + 2] = 0;
      } else {
        const v = Math.round(92 + low * 10 + grain * 8);
        img.data[i] = v;
        img.data[i + 1] = v + 2;
        img.data[i + 2] = v + 5;
      }
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  if (!orm) {
    // Juntas de dilatação.
    ctx.strokeStyle = "rgba(20,22,25,0.55)";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, s - 2, s - 2);
  }
  tex.update();
  tex.uScale = uScale; // placas de 2 m
  tex.vScale = vScale;
  return tex;
}

/** Tampo fenólico grafite com leve textura e linha guia. */
function makeWorktopTexture(scene: Scene): DynamicTexture {
  const w = 512;
  const h = 256;
  const tex = new DynamicTexture("bancada_tex", { width: w, height: h }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.fillStyle = "#454b52";
  ctx.fillRect(0, 0, w, h);
  let seed = 99;
  const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 9000; i++) {
    const v = Math.round(62 + rnd() * 14);
    ctx.fillStyle = `rgb(${v},${v + 3},${v + 7})`;
    ctx.fillRect(rnd() * w, rnd() * h, 1.5, 1.5);
  }
  tex.update();
  return tex;
}

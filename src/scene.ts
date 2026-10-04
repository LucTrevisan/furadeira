import {
  ArcRotateCamera,
  Color3,
  Color4,
  DirectionalLight,
  DynamicTexture,
  Engine,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import { SCENE, VISUAL } from "./config";

export interface SceneContext {
  scene: Scene;
  camera: ArcRotateCamera;
  ground: Mesh;
  tableTopY: number;
  sun: DirectionalLight;
  shadows: ShadowGenerator | null;
}

/** Cena simples de oficina: piso com grade de 1 m, bancada e iluminação. */
export function createScene(engine: Engine, canvas: HTMLCanvasElement): SceneContext {
  const scene = new Scene(engine);
  // Cor de fundo não-preta: distingue "nada renderizou" de "material preto".
  scene.clearColor = new Color4(0.13, 0.145, 0.165, 1);
  scene.skipPointerMovePicking = true; // nada na cena depende de hover no desktop

  const tableTopY = SCENE.tableHeight;
  const { x: dx, z: dz } = SCENE.drillPosition;

  // ---- Câmera desktop/celular -------------------------------------------
  // alpha = −π/2 → câmera atrás (z menor) olhando para +Z, igual à pose inicial no VR.
  const camera = new ArcRotateCamera("camera", -Math.PI / 2, 1.1, 0.8, new Vector3(dx, tableTopY + 0.08, dz), scene);
  camera.minZ = 0.01; // o modelo é pequeno (≈0,4 m)
  camera.maxZ = 60;
  camera.lowerRadiusLimit = 0.08;
  camera.upperRadiusLimit = 4;
  camera.lowerBetaLimit = 0.15;
  camera.upperBetaLimit = Math.PI * 0.62;
  camera.wheelDeltaPercentage = 0.01;
  camera.pinchDeltaPercentage = 0.004;
  camera.useNaturalPinchZoom = true;
  camera.panningSensibility = 3000;
  camera.attachControl(canvas, true);

  // ---- Luzes --------------------------------------------------------------
  const hemi = new HemisphericLight("luz_ambiente", new Vector3(0.2, 1, -0.3), scene);
  hemi.intensity = 0.55;
  hemi.groundColor = new Color3(0.22, 0.22, 0.25);

  const sun = new DirectionalLight("luz_principal", new Vector3(-0.35, -1, 0.45).normalize(), scene);
  sun.position = new Vector3(dx + 1.2, tableTopY + 2.5, dz - 1.4);
  sun.intensity = 1.5;

  // Iluminação baseada em imagem: sem ela, materiais PBR metálicos ficam pretos.
  try {
    scene.createDefaultEnvironment({ createSkybox: false, createGround: false });
    scene.environmentIntensity = 0.85;
  } catch (e) {
    console.warn("[cena] Ambiente IBL indisponível; metais podem parecer escuros.", e);
  }

  // ---- Piso (grade de 1 m ajuda a perceber a escala no VR) ---------------
  const ground = MeshBuilder.CreateGround("piso", { width: 10, height: 10 }, scene);
  const groundMat = new StandardMaterial("piso_mat", scene);
  groundMat.diffuseTexture = makeTileTexture(scene);
  groundMat.specularColor = new Color3(0.05, 0.05, 0.05);
  ground.material = groundMat;
  ground.receiveShadows = true;
  groundMat.freeze();

  // ---- Bancada ------------------------------------------------------------
  const { width, depth } = SCENE.tableSize;
  const top = MeshBuilder.CreateBox("bancada_tampo", { width, height: 0.04, depth }, scene);
  top.position.set(dx, tableTopY - 0.02, dz);
  const topMat = new StandardMaterial("bancada_tampo_mat", scene);
  topMat.diffuseColor = new Color3(0.42, 0.36, 0.29);
  topMat.specularColor = new Color3(0.08, 0.08, 0.08);
  top.material = topMat;
  top.receiveShadows = true;
  topMat.freeze();

  const legs: Mesh[] = [];
  const legH = tableTopY - 0.04;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = MeshBuilder.CreateBox("perna", { width: 0.05, height: legH, depth: 0.05 }, scene);
      leg.position.set(dx + sx * (width / 2 - 0.06), legH / 2, dz + sz * (depth / 2 - 0.06));
      legs.push(leg);
    }
  }
  const frame = Mesh.MergeMeshes(legs, true)!;
  frame.name = "bancada_estrutura";
  const frameMat = new StandardMaterial("bancada_estrutura_mat", scene);
  frameMat.diffuseColor = new Color3(0.16, 0.18, 0.2);
  frame.material = frameMat;
  frameMat.freeze();

  // Faixa de segurança no piso, à frente da bancada.
  const stripe = MeshBuilder.CreateGround("faixa_seguranca", { width: width + 0.4, height: 0.08 }, scene);
  stripe.position.set(dx, 0.002, dz - depth / 2 - 0.35);
  const stripeMat = new StandardMaterial("faixa_mat", scene);
  stripeMat.diffuseTexture = makeHazardTexture(scene);
  stripeMat.specularColor = Color3.Black();
  stripe.material = stripeMat;
  stripeMat.freeze();

  for (const m of [top, frame, stripe]) {
    m.isPickable = false;
    m.freezeWorldMatrix();
  }
  ground.freezeWorldMatrix();

  // ---- Sombras (desativadas automaticamente no VR) -----------------------
  let shadows: ShadowGenerator | null = null;
  if (VISUAL.shadows) {
    shadows = new ShadowGenerator(1024, sun);
    shadows.usePercentageCloserFiltering = true;
    shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    shadows.bias = 0.0008;
    shadows.normalBias = 0.002;
    shadows.setDarkness(0.35);
  }

  return { scene, camera, ground, tableTopY, sun, shadows };
}

function makeTileTexture(scene: Scene): DynamicTexture {
  const s = 256;
  const tex = new DynamicTexture("piso_tex", { width: s, height: s }, scene, true);
  const ctx = tex.getContext();
  ctx.fillStyle = "#3a3f45";
  ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = "#4b525a";
  ctx.lineWidth = 4;
  ctx.strokeRect(0, 0, s, s);
  tex.update();
  tex.uScale = 10; // piso de 10 m → ladrilhos de 1 m
  tex.vScale = 10;
  return tex;
}

function makeHazardTexture(scene: Scene): DynamicTexture {
  const w = 512;
  const h = 32;
  const tex = new DynamicTexture("faixa_tex", { width: w, height: h }, scene, true);
  const ctx = tex.getContext();
  ctx.fillStyle = "#f5c518";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#1b1b1b";
  for (let x = -h; x < w + h; x += h * 2) {
    ctx.beginPath();
    ctx.moveTo(x, h);
    ctx.lineTo(x + h, 0);
    ctx.lineTo(x + h * 2, 0);
    ctx.lineTo(x + h, h);
    ctx.closePath();
    ctx.fill();
  }
  tex.update();
  return tex;
}

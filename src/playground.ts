import * as BABYLON from "@babylonjs/core";

interface Box {
  w: number;
  h: number;
  x?: number;
  y?: number;
  originalUv?: BABYLON.FloatArray;
  minU?: number;
  maxU?: number;
  minV?: number;
  maxV?: number;
}

declare module "@babylonjs/core" {
  interface Material {
    progressiveShadowMapPlugin?: ProgressiveShadowMapMaterialPlugin;
  }
}

// TODO: Optionally blur using a blur plane mesh like how three.js does it
class ProgressiveShadowMapMaterialPlugin extends BABYLON.MaterialPluginBase {
  private _enabled: boolean = true;
  private _previousShadowMap?: BABYLON.BaseTexture;
  private _isFirstIteration: boolean = true;

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(value: boolean) {
    if (this._enabled !== value) {
      this._enabled = value;
      this._enable(value);
    }
  }

  get isFirstIteration(): boolean {
    return this._isFirstIteration;
  }

  set isFirstIteration(value: boolean) {
    if (this._isFirstIteration !== value) {
      this._isFirstIteration = value;
    }

    this.markAllDefinesAsDirty();
  }

  constructor(
    material: BABYLON.Material,
    {
      name = "progressive-shadow-map-plugin",
      priority = 200,
      defines = {
        FIRST_ITERATION: true,
      },
      addToPluginList = true,
      enable = true,
      resolveIncludes = true,
    }
  ) {
    super(
      material,
      name,
      priority,
      defines,
      addToPluginList,
      enable,
      resolveIncludes
    );
    this._enable(true);
  }

  getClassName() {
    return "ProgressiveShadowMapMaterialPlugin";
  }

  getAttributes(attr: any) {
    attr.push("uv2");
  }

  getSamplers(samplers: string[]) {
    samplers.push("previousShadowMap");
  }

  prepareDefines(
    defines: any,
    _scene: BABYLON.Scene,
    _mesh: BABYLON.AbstractMesh
  ) {
    defines.FIRST_ITERATION = this._isFirstIteration;
  }

  getCustomCode(shaderType: string, _shaderLanguage: BABYLON.ShaderLanguage) {
    const customCode = {
      CUSTOM_VERTEX_DEFINITIONS: "",
      CUSTOM_VERTEX_MAIN_END: "",
      CUSTOM_FRAGMENT_DEFINITIONS: "",
      CUSTOM_FRAGMENT_MAIN_END: "",
    };

    if (shaderType === "vertex") {
      customCode["CUSTOM_VERTEX_DEFINITIONS"] = `
          precision highp float;
          attribute vec2 uv2;
          varying vec2 vUV2;
      `;
      customCode["CUSTOM_VERTEX_MAIN_END"] = `
        vUV2 = uv2;
        vec2 uvTransformed = (uv2 - 0.5) * 2.0;
        gl_Position = vec4(uvTransformed.x, uvTransformed.y, 0.0, 1.0);
      `;
    } else if (shaderType === "fragment") {
      customCode["CUSTOM_FRAGMENT_DEFINITIONS"] = `
        #ifndef FIRST_ITERATION
          uniform sampler2D previousShadowMap;
          varying vec2 vUV2;
        #endif
      `;
      customCode["CUSTOM_FRAGMENT_MAIN_END"] = `
        #ifndef FIRST_ITERATION
          vec4 previousShadowColor = texture2D(previousShadowMap, vUV2);
          gl_FragColor.rgb = mix(previousShadowColor.rgb, gl_FragColor.rgb, 0.1);
        #endif
      `;
    }

    return customCode;
  }

  setPreviousShadowMap(texture: BABYLON.BaseTexture) {
    this._previousShadowMap = texture;
  }

  bindForSubMesh(
    uniformBuffer: BABYLON.UniformBuffer,
    _scene: BABYLON.Scene,
    _engine: BABYLON.AbstractEngine,
    _subMesh: BABYLON.SubMesh
  ): void {
    if (this._previousShadowMap) {
      uniformBuffer.setTexture("previousShadowMap", this._previousShadowMap);
    }
  }
}

class ProgressiveShadowMap {
  private _afterRenderObservable: BABYLON.Observable<void>;
  private _afterBlendIterationObservable: BABYLON.Observable<void>;
  private _light: BABYLON.DirectionalLight;
  private _originalLightDirection: BABYLON.Vector3;

  private _pingPongRTT1: BABYLON.RenderTargetTexture;
  private _pingPongRTT2: BABYLON.RenderTargetTexture;
  private _useAlternateRTT: boolean = false;

  private _meshMaterialRTT1Map: Map<number, BABYLON.Material> = new Map();
  private _meshMaterialRTT2Map: Map<number, BABYLON.Material> = new Map();

  constructor(
    scene: BABYLON.Scene,
    light: BABYLON.DirectionalLight,
    size: number = 512
  ) {
    this._afterRenderObservable = new BABYLON.Observable<void>();
    this._afterBlendIterationObservable = new BABYLON.Observable<void>();
    this._light = light;
    this._originalLightDirection = light.direction.clone();

    this._pingPongRTT1 = new BABYLON.RenderTargetTexture(
      "pingPongRTT1",
      size,
      scene,
      false,
      true
    );
    this._pingPongRTT1.wrapU = BABYLON.Texture.CLAMP_ADDRESSMODE;
    this._pingPongRTT1.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
    this._pingPongRTT1.activeCamera = null; // Disable frustum culling
    this._pingPongRTT1.coordinatesIndex = 1; // Use UV2

    this._pingPongRTT2 = new BABYLON.RenderTargetTexture(
      "pingPongRTT2",
      size,
      scene,
      false,
      true
    );
    this._pingPongRTT2.wrapU = BABYLON.Texture.CLAMP_ADDRESSMODE;
    this._pingPongRTT2.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
    this._pingPongRTT2.activeCamera = null; // Disable frustum culling
    this._pingPongRTT2.coordinatesIndex = 1; // Use UV2
  }

  public get afterRenderObservable(): BABYLON.Observable<void> {
    return this._afterRenderObservable;
  }

  public get afterBlendIterationObservable(): BABYLON.Observable<void> {
    return this._afterBlendIterationObservable;
  }

  public addMeshes(meshes: BABYLON.AbstractMesh[]): void {
    const boxes = meshes.map((mesh) => {
      const uv1 = mesh.getVerticesData(BABYLON.VertexBuffer.UVKind);
      if (uv1) {
        return this._uv1ToBox(uv1);
      }
      return {
        w: 0,
        h: 0,
      };
    });

    const { w, h } = potpack(boxes);

    meshes.forEach((mesh, index) => {
      if (
        !mesh ||
        !mesh.getVerticesData ||
        mesh.name.startsWith("uv_") ||
        mesh.name.includes("debugPlane")
      ) {
        return;
      }
      const box = boxes[index];
      if (!box || box.w === 0 || box.h === 0) {
        console.warn(`Mesh ${mesh.name} has no valid UV data.`);
        return;
      }

      const uv2 = this._boxToUv2(box, w, h);
      mesh.setVerticesData(BABYLON.VertexBuffer.UV2Kind, uv2);

      if (mesh.material) {
        if (!this._pingPongRTT1?.renderList) {
          this._pingPongRTT1.renderList = [];
        }

        if (!this._pingPongRTT2?.renderList) {
          this._pingPongRTT2.renderList = [];
        }

        this._pingPongRTT1.renderList!.push(mesh);
        const matRTT1 = this._createProgressiveShadowMapMaterial(mesh.material);
        this._meshMaterialRTT1Map.set(mesh.uniqueId, matRTT1);
        this._pingPongRTT1.setMaterialForRendering(mesh, matRTT1);

        this._pingPongRTT2.renderList!.push(mesh);
        const matRTT2 = this._createProgressiveShadowMapMaterial(mesh.material);
        this._meshMaterialRTT2Map.set(mesh.uniqueId, matRTT2);
        this._pingPongRTT2.setMaterialForRendering(mesh, matRTT2);

        matRTT1.progressiveShadowMapPlugin?.setPreviousShadowMap(
          this._pingPongRTT2
        );
        matRTT2.progressiveShadowMapPlugin?.setPreviousShadowMap(
          this._pingPongRTT1
        );

        matRTT1.progressiveShadowMapPlugin!.isFirstIteration = true;
        matRTT2.progressiveShadowMapPlugin!.isFirstIteration = false;
      }
    });
  }

  public async render(
    blendWindow: number = 1,
    waitBetweenRenders: number = 0
  ): Promise<void> {
    const scene = this._pingPongRTT1.getScene();
    if (!scene) {
      throw new Error(
        "Scene not available for progressive shadow map rendering"
      );
    }

    let currentIteration = 0;
    let startTime = performance.now();

    return new Promise<void>((resolve) => {
      const renderObserver = scene.onBeforeRenderObservable.add(async () => {
        if (performance.now() - startTime < waitBetweenRenders) {
          resolve();
          return;
        }

        if (currentIteration >= blendWindow) {
          scene.onBeforeRenderObservable.remove(renderObserver);
          this._restoreOriginalLight();
          this._afterRenderObservable.notifyObservers();

          resolve();
          return;
        }

        this._jitterLight(currentIteration, blendWindow);

        const writeRTT = this._getWriteRTT();
        if (writeRTT.renderList && writeRTT.renderList.length > 0) {
          if (
            currentIteration === 0 ||
            currentIteration === 1 ||
            currentIteration === 2
          ) {
            writeRTT.renderList.forEach((mesh) => {
              const mat = this._getWriteRTTMeshMaterial(mesh);
              const plugin = mat?.progressiveShadowMapPlugin;

              if (plugin) {
                plugin.isFirstIteration = currentIteration === 0;
              }
            });
          }

          await new Promise<void>((res) => {
            if (writeRTT.isReadyForRendering()) {
              res();
            }
          });

          startTime = performance.now();

          writeRTT.render();

          this._flipRTTs();

          this._afterBlendIterationObservable.notifyObservers();
        }

        currentIteration++;
      });
    });
  }

  public getShadowMap(): BABYLON.BaseTexture {
    return this._getReadRTT();
  }

  public dispose(): void {
    this._pingPongRTT1.renderList?.forEach((mesh) => {
      mesh.dispose();
    });
    this._pingPongRTT1.dispose();
    this._pingPongRTT2?.dispose();
    this._afterRenderObservable.clear();
    this._afterBlendIterationObservable.clear();
  }

  private _getWriteRTT(): BABYLON.RenderTargetTexture {
    return this._useAlternateRTT ? this._pingPongRTT2! : this._pingPongRTT1;
  }

  private _getWriteRTTMeshMaterial(
    mesh: BABYLON.AbstractMesh
  ): BABYLON.Material | undefined {
    return this._useAlternateRTT
      ? this._meshMaterialRTT2Map.get(mesh.uniqueId)
      : this._meshMaterialRTT1Map.get(mesh.uniqueId);
  }

  private _getReadRTT(): BABYLON.RenderTargetTexture {
    return this._useAlternateRTT ? this._pingPongRTT1 : this._pingPongRTT2!;
  }

  private _flipRTTs(): void {
    this._useAlternateRTT = !this._useAlternateRTT;
  }

  private _createProgressiveShadowMapMaterial(
    originalMaterial: BABYLON.Material
  ): BABYLON.Material {
    const material = originalMaterial.clone("uv_" + originalMaterial.name);
    if (!material) {
      throw new Error("Failed to clone material for UV unwrapping.");
    }

    material.backFaceCulling = false; // Prevent culling in UV space
    material.progressiveShadowMapPlugin =
      new ProgressiveShadowMapMaterialPlugin(material, {});

    return material;
  }

  private _uv1ToBox(uv: BABYLON.FloatArray): Box {
    if (!uv || uv.length === 0) {
      return {
        w: 0,
        h: 0,
        x: 0,
        y: 0,
        originalUv: uv,
        minU: 0,
        maxU: 0,
        minV: 0,
        maxV: 0,
      };
    }
    let minU = Infinity,
      maxU = -Infinity;
    let minV = Infinity,
      maxV = -Infinity;
    for (let i = 0; i < uv.length; i += 2) {
      const u = uv[i];
      const v = uv[i + 1];
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    return {
      w: maxU - minU,
      h: maxV - minV,
      x: 0,
      y: 0,
      originalUv: uv,
      minU,
      maxU,
      minV,
      maxV,
    };
  }

  private _boxToUv2(
    box: Box,
    containerW: number,
    containerH: number
  ): Float32Array {
    if (
      !box.originalUv ||
      box.originalUv.length === 0 ||
      box.x === undefined ||
      box.y === undefined ||
      box.minU === undefined ||
      box.maxU === undefined ||
      box.minV === undefined ||
      box.maxV === undefined
    ) {
      return new Float32Array(0);
    }

    const uv2 = new Float32Array(box.originalUv.length);
    for (let i = 0; i < box.originalUv.length; i += 2) {
      const u = box.originalUv[i];
      const v = box.originalUv[i + 1];
      const normalizedU = (u - box.minU) / (box.maxU - box.minU);
      const normalizedV = (v - box.minV) / (box.maxV - box.minV);
      uv2[i] = (box.x + normalizedU * box.w) / containerW;
      uv2[i + 1] = (box.y + normalizedV * box.h) / containerH;
    }

    return uv2;
  }

  private _jitterLight(iteration: number, totalIterations: number): void {
    // Generate pseudo-random jitter based on iteration
    const jitterRadius = 0.025; // Maximum jitter radius
    const angle1 =
      (iteration / totalIterations) * Math.PI * 2 + iteration * 0.618034; // Golden angle
    const angle2 = Math.sin(iteration * 2.39996) * Math.PI; // Secondary angle

    const jitterX = Math.sin(angle1) * Math.cos(angle2) * jitterRadius;
    const jitterY = Math.cos(angle1) * jitterRadius;
    const jitterZ = Math.sin(angle1) * Math.sin(angle2) * jitterRadius;

    const jitterDir = this._originalLightDirection.clone();
    jitterDir.x += jitterX;
    jitterDir.y += jitterY;
    jitterDir.z += jitterZ;
    jitterDir.normalize();

    this._light.direction = jitterDir;
  }

  private _restoreOriginalLight(): void {
    this._light.direction = this._originalLightDirection.clone();
  }
}

export class Playground {
  public static CreateScene(
    engine: BABYLON.Engine,
    canvas: HTMLCanvasElement
  ): BABYLON.Scene {
    const scene = new BABYLON.Scene(engine);

    // Add lighting
    const light = new BABYLON.DirectionalLight(
      "light",
      new BABYLON.Vector3(0, 1, 0),
      scene
    );
    light.intensity = 4.0;
    light.direction = new BABYLON.Vector3(
      0.3204164226684694,
      -0.897774797464629,
      -0.3022147069910482
    );
    light.autoCalcShadowZBounds = true;
    light.autoUpdateExtends = true;

    const shadowGenerator = new BABYLON.ShadowGenerator(1024, light);

    const camera = new BABYLON.ArcRotateCamera(
      "camera1",
      1.6018,
      1.3705,
      32,
      new BABYLON.Vector3(0, 0, 0),
      scene
    );
    camera.attachControl(canvas, true);
    camera.minZ = 0;

    const progressiveShadowMap = new ProgressiveShadowMap(scene, light, 1024);

    const ground = BABYLON.MeshBuilder.CreateGround("ground", {
      width: 30,
      height: 30,
    });
    ground.position.y = -3;

    const sphere1 = BABYLON.MeshBuilder.CreateIcoSphere("sphere1", {
      radius: 3,
    });
    const sphere2 = sphere1.clone("sphere2");
    const sphere3 = sphere1.clone("sphere3");

    sphere2.position.x = 7;
    sphere3.position.x = -7;

    sphere2.makeGeometryUnique();
    sphere3.makeGeometryUnique();

    const groundMat = new BABYLON.PBRMaterial("groundMat", scene);
    groundMat.albedoColor = BABYLON.Color3.White();
    groundMat.metallic = 0.0;
    groundMat.roughness = 1.0;
    const redMat = new BABYLON.StandardMaterial("redMat", scene);
    redMat.diffuseColor = BABYLON.Color3.Red();
    const greenMat = new BABYLON.StandardMaterial("greenMat", scene);
    greenMat.diffuseColor = BABYLON.Color3.Green();
    const blueMat = new BABYLON.StandardMaterial("blueMat", scene);
    blueMat.diffuseColor = BABYLON.Color3.Blue();

    ground.material = groundMat;
    sphere1.material = greenMat;
    sphere2.material = redMat;
    sphere3.material = blueMat;

    shadowGenerator.addShadowCaster(sphere1);
    shadowGenerator.addShadowCaster(sphere2);
    shadowGenerator.addShadowCaster(sphere3);

    ground.receiveShadows = true;

    progressiveShadowMap.addMeshes([ground, sphere1, sphere2, sphere3]);
    scene.onReadyObservable.addOnce(() => {
      progressiveShadowMap.render(64);
    });

    const afterBlenderIterationObservable =
      progressiveShadowMap.afterBlendIterationObservable.add(() => {
        groundMat.lightmapTexture = progressiveShadowMap.getShadowMap();
        groundMat.useLightmapAsShadowmap = true;
      });

    progressiveShadowMap.afterRenderObservable.addOnce(async () => {
      afterBlenderIterationObservable.remove();
      groundMat.lightmapTexture = progressiveShadowMap.getShadowMap();
      groundMat.useLightmapAsShadowmap = true;

      light.shadowEnabled = false;

      // Create a debug plane to visualize the shadow map
      const debugPlane = BABYLON.MeshBuilder.CreatePlane(
        "debugPlane",
        {
          size: 10,
        },
        scene
      );
      debugPlane.position.z = -15;
      debugPlane.position.y = 5;
      debugPlane.rotation.y = Math.PI; // Rotate 180 degrees

      const debugMaterial = new BABYLON.StandardMaterial("debugMat", scene);
      debugMaterial.backFaceCulling = false;
      debugMaterial.diffuseTexture = await deepCloneTexture(
        progressiveShadowMap.getShadowMap()
      ); // Deep clone the texture to use the UV1 coordinates
      debugPlane.material = debugMaterial;
    });

    return scene;
  }
}

async function deepCloneTexture(
  texture: BABYLON.BaseTexture
): Promise<BABYLON.BaseTexture> {
  const engine = texture.getScene()!.getEngine();
  if (!(engine instanceof BABYLON.Engine)) {
    console.warn("deepCloneTexture is only supported in WebGL2.");
    return texture;
  }

  const pixels = await texture.readPixels();
  const destinationPixels = new Uint8Array(pixels!.buffer).slice(0);
  const currentTextureSize = texture.getSize();

  // Create a new render target texture with the same size
  const clonedTexture = new BABYLON.RenderTargetTexture(
    texture.name + "_clone",
    currentTextureSize,
    texture.getScene()!,
    false,
    true
  );

  engine.updateTextureData(
    clonedTexture.getInternalTexture()!,
    destinationPixels,
    0,
    0,
    currentTextureSize.width,
    currentTextureSize.height,
    0,
    0,
    false
  );

  return clonedTexture;
}

/**
 * potpack - https://github.com/mapbox/potpack
 *
 * A tiny JavaScript function for packing 2D rectangles into a near-square container,
 * which is useful for generating CSS sprites and WebGL textures. Similar to
 * [shelf-pack](https://github.com/mapbox/shelf-pack), but static (you can't add items
 * once a layout is generated), and aims for maximal space utilization.
 *
 * A variation of algorithms used in [rectpack2D](https://github.com/TeamHypersomnia/rectpack2D)
 * and [bin-pack](https://github.com/bryanburgers/bin-pack), which are in turn based
 * on [this article by Blackpawn](http://blackpawn.com/texts/lightmaps/default.html).
 *
 * @license
 * ISC License
 *
 * Copyright (c) 2022, Mapbox
 *
 * Permission to use, copy, modify, and/or distribute this software for any purpose
 * with or without fee is hereby granted, provided that the above copyright notice
 * and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
 * FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
 * OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
 * TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
 * THIS SOFTWARE.
 */
function potpack(boxes: Box[]) {
  // calculate total box area and maximum box width
  let area = 0;
  let maxWidth = 0;

  for (const box of boxes) {
    area += box.w * box.h;
    maxWidth = Math.max(maxWidth, box.w);
  }

  // sort the boxes for insertion by height, descending
  boxes.sort((a, b) => b.h - a.h);

  // aim for a squarish resulting container,
  // slightly adjusted for sub-100% space utilization
  const startWidth = Math.max(Math.ceil(Math.sqrt(area / 0.95)), maxWidth);

  // start with a single empty space, unbounded at the bottom
  const spaces = [{ x: 0, y: 0, w: startWidth, h: Infinity }];

  let width = 0;
  let height = 0;

  for (const box of boxes) {
    // look through spaces backwards so that we check smaller spaces first
    for (let i = spaces.length - 1; i >= 0; i--) {
      const space = spaces[i];

      // look for empty spaces that can accommodate the current box
      if (box.w > space.w || box.h > space.h) continue;

      // found the space; add the box to its top-left corner
      // |-------|-------|
      // |  box  |       |
      // |_______|       |
      // |         space |
      // |_______________|
      box.x = space.x;
      box.y = space.y;

      height = Math.max(height, box.y + box.h);
      width = Math.max(width, box.x + box.w);

      if (box.w === space.w && box.h === space.h) {
        // space matches the box exactly; remove it
        const last = spaces.pop();
        if (i < spaces.length && last) spaces[i] = last;
      } else if (box.h === space.h) {
        // space matches the box height; update it accordingly
        // |-------|---------------|
        // |  box  | updated space |
        // |_______|_______________|
        space.x += box.w;
        space.w -= box.w;
      } else if (box.w === space.w) {
        // space matches the box width; update it accordingly
        // |---------------|
        // |      box      |
        // |_______________|
        // | updated space |
        // |_______________|
        space.y += box.h;
        space.h -= box.h;
      } else {
        // otherwise the box splits the space into two spaces
        // |-------|-----------|
        // |  box  | new space |
        // |_______|___________|
        // | updated space     |
        // |___________________|
        spaces.push({
          x: space.x + box.w,
          y: space.y,
          w: space.w - box.w,
          h: box.h,
        });
        space.y += box.h;
        space.h -= box.h;
      }
      break;
    }
  }

  return {
    w: width, // container width
    h: height, // container height
    fill: area / (width * height) || 0, // space utilization
  };
}

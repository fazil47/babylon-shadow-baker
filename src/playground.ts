import * as BABYLON from "@babylonjs/core";

interface Box {
    w: number;
    h: number;
    index: number;
    x: number;
    y: number;
    originalUv: BABYLON.FloatArray;
    minU: number;
    maxU: number;
    minV: number;
    maxV: number;
}

class UVUnwrappingPlugin extends BABYLON.MaterialPluginBase {
    constructor(material: BABYLON.Material, {
        name = "uv_unwrapping_plugin",
        priority = 200,
        defines = {
            "UV_UNWRAPPING": true,
        },
        addToPluginList = true,
        enable = true,
        resolveIncludes = true,
    }) {
        super(
            material,
            name,
            priority,
            defines,
            addToPluginList,
            enable,
            resolveIncludes,
        );
        this._enable(true);
    }

    getClassName() {
        return "UVUnwrappingPlugin";
    }

    getAttributes(attr: any) {
        attr.push("uv2");
    }

    getCustomCode(shaderType: string) {
        if (shaderType === "vertex") {
            return {
                CUSTOM_VERTEX_DEFINITIONS: `
                      precision highp float;
                      attribute vec2 uv2;
                  `,

                CUSTOM_VERTEX_MAIN_END: `
                      #ifdef UV_UNWRAPPING
                          vec2 uvTransformed = (uv2 - 0.5) * 2.0;
                          gl_Position = vec4(uvTransformed.x, uvTransformed.y, 0.0, 1.0);
                      #endif
                  `,
            };
        }

        return null;
    }
}

class ProgressiveShadowMap {
    private _scene: BABYLON.Scene;
    private _size: number;
    private _enableBlur: boolean;
    private _blurIntensity: number;
    private _blurPostProcessHorizontal?: BABYLON.BlurPostProcess;
    private _blurPostProcessVertical?: BABYLON.BlurPostProcess;

    private _pingPongRTT1: BABYLON.RenderTargetTexture;
    private _pingPongRTT2?: BABYLON.RenderTargetTexture;
    private _useAlternateRTT: boolean = false;

    constructor(
        scene: BABYLON.Scene,
        size: number = 512,
        enableBlur: boolean = false,
        blurIntensity: number = 1.0,
    ) {
        this._scene = scene;
        this._size = size;
        this._enableBlur = enableBlur;
        this._blurIntensity = blurIntensity;

        this._pingPongRTT1 = new BABYLON.RenderTargetTexture(
            "pingPongRTT1",
            size,
            scene,
            false,
            true,
        );
        this._pingPongRTT1.wrapU = BABYLON.Texture.CLAMP_ADDRESSMODE;
        this._pingPongRTT1.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;

        this._pingPongRTT2 = new BABYLON.RenderTargetTexture(
            "pingPongRTT2",
            size,
            scene,
            false,
            true,
        );
        this._pingPongRTT2.wrapU = BABYLON.Texture.CLAMP_ADDRESSMODE;
        this._pingPongRTT2.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;

        if (this._enableBlur) {
            this._setupBlurPostProcess();
        }
    }

    public addMeshes(meshes: BABYLON.AbstractMesh[]): void {
        const boxes = meshes.map((mesh, index) => {
            const uv1 = mesh.getVerticesData(BABYLON.VertexBuffer.UVKind);
            if (uv1) {
                return this._uv1ToBox(uv1, index);
            }
            return null;
        }).filter((box): box is Box => box !== null);

        const { w, h } = potpack(boxes);

        const writeRTT = this._getWriteRTT();
        meshes.forEach((mesh, index) => {
            if (
                !mesh ||
                !mesh.getVerticesData ||
                mesh.name.startsWith("uv_") ||
                mesh.name.includes("debugPlane")
            ) {
                return;
            }
            const uv2 = this._boxToUv2(boxes[index], w, h);
            mesh.setVerticesData(BABYLON.VertexBuffer.UV2Kind, uv2);

            const uvMesh = mesh.clone("uv_" + mesh.name, null);
            if (uvMesh && mesh.material) {
                if (!writeRTT?.renderList) {
                    writeRTT.renderList = [];
                }

                uvMesh.material = this._createUVMaterial(mesh.material);
                writeRTT.renderList.push(uvMesh);
            }
        });
    }

    public render(blendWindow: number = 1): void {
        for (let i = 0; i < blendWindow; i++) {
            const writeRTT = this._getWriteRTT();
            if (
                writeRTT.renderList &&
                writeRTT.renderList?.length > 0
            ) {
                writeRTT.render();

                if (i == blendWindow - 1) {
                    writeRTT.renderList.forEach((mesh) => {
                        mesh.isVisible = false;
                    });
                }

                this._flipRTTs();
            }
        }
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
        this._blurPostProcessHorizontal?.dispose();
        this._blurPostProcessVertical?.dispose();
    }

    private _getWriteRTT(): BABYLON.RenderTargetTexture {
        return this._useAlternateRTT ? this._pingPongRTT2! : this._pingPongRTT1;
    }

    private _getReadRTT(): BABYLON.RenderTargetTexture {
        return this._useAlternateRTT ? this._pingPongRTT1 : this._pingPongRTT2!;
    }

    private _flipRTTs(): void {
        this._useAlternateRTT = !this._useAlternateRTT;
        const writeRTT = this._getWriteRTT();
        const readRTT = this._getReadRTT();
        writeRTT.renderList = readRTT.renderList;
        readRTT.renderList = [];
    }

    private _createUVMaterial(
        originalMaterial: BABYLON.Material,
    ): BABYLON.Material {
        const material = originalMaterial.clone("uv_" + originalMaterial.name);
        if (!material) {
            throw new Error("Failed to clone material for UV unwrapping.");
        }
        new UVUnwrappingPlugin(material, {});
        return material;
    }

    private _uv1ToBox(uv: BABYLON.FloatArray, index: number): Box {
        if (!uv || uv.length === 0) {
            return {
                w: 0,
                h: 0,
                index,
                x: 0,
                y: 0,
                originalUv: uv,
                minU: 0,
                maxU: 0,
                minV: 0,
                maxV: 0,
            };
        }
        let minU = Infinity, maxU = -Infinity;
        let minV = Infinity, maxV = -Infinity;
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
            index,
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
        containerH: number,
    ): Float32Array {
        if (!box.originalUv || box.originalUv.length === 0) {
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

    private _setupBlurPostProcess(): void {
        const kernel = this._blurIntensity * 100.0;

        // Horizontal blur first
        this._blurPostProcessHorizontal = new BABYLON.BlurPostProcess(
            "Horizontal blur",
            new BABYLON.Vector2(1.0, 0),
            kernel,
            1,
            null,
            0,
            this._scene.getEngine(),
        );
        this._blurPostProcessHorizontal.width = this._size;
        this._blurPostProcessHorizontal.height = this._size;
        this._blurPostProcessHorizontal.onApply = (effect: BABYLON.Effect) => {
            effect.setTexture("textureSampler", this._getWriteRTT());
        };

        // Vertical blur second
        this._blurPostProcessVertical = new BABYLON.BlurPostProcess(
            "Vertical blur",
            new BABYLON.Vector2(0, 1.0),
            kernel,
            1,
            null,
            0,
            this._scene.getEngine(),
        );
        this._blurPostProcessVertical.width = this._size;
        this._blurPostProcessVertical.height = this._size;
        this._blurPostProcessVertical.onApply = (effect: BABYLON.Effect) => {
            effect.setTexture("textureSampler", this._getWriteRTT());
        };

        this._scene.onAfterRenderObservable.add(() => {
            const readRTT = this._getReadRTT()?.renderTarget;

            if (!readRTT) {
                console.warn("Read RTT not found.");
                return;
            }

            this._scene.postProcessManager.directRender(
                [
                    this._blurPostProcessHorizontal!,
                    this._blurPostProcessVertical!,
                ],
                readRTT,
                true,
            );
        });
    }
}

export class Playground {
    public static CreateScene(
        engine: BABYLON.Engine,
        canvas: HTMLCanvasElement,
    ): BABYLON.Scene {
        const scene = new BABYLON.Scene(engine);

        // Add lighting
        const light = new BABYLON.DirectionalLight(
            "light",
            new BABYLON.Vector3(0, 1, 0),
            scene,
        );
        light.intensity = 4.0;
        light.direction = new BABYLON.Vector3(
            0.3204164226684694,
            -0.897774797464629,
            -0.3022147069910482,
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
            scene,
        );
        camera.attachControl(canvas, true);
        camera.minZ = 0;

        // Create progressive shadowmap instance with blur enabled
        const progressiveShadowMap = new ProgressiveShadowMap(
            scene,
            512,
            true,
            0.5,
        );

        // Create debug plane to show the UV render target
        const debugPlane = BABYLON.MeshBuilder.CreatePlane("debugPlane", {
            size: 10,
        }, scene);
        debugPlane.position.z = -15;
        debugPlane.position.y = 5;
        debugPlane.rotation.y = Math.PI; // Rotate 180 degrees

        const debugMaterial = new BABYLON.StandardMaterial("debugMat", scene);

        debugMaterial.backFaceCulling = false;
        debugMaterial.diffuseTexture = progressiveShadowMap.getShadowMap();
        debugMaterial.emissiveTexture = progressiveShadowMap.getShadowMap();
        debugPlane.material = debugMaterial;

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

        const whiteMat = new BABYLON.PBRMaterial("whiteMat", scene);
        whiteMat.albedoColor = BABYLON.Color3.White();
        whiteMat.metallic = 0.0;
        whiteMat.roughness = 1.0;
        const redMat = new BABYLON.StandardMaterial("redMat", scene);
        redMat.diffuseColor = BABYLON.Color3.Red();
        const greenMat = new BABYLON.StandardMaterial("greenMat", scene);
        greenMat.diffuseColor = BABYLON.Color3.Green();
        const blueMat = new BABYLON.StandardMaterial("blueMat", scene);
        blueMat.diffuseColor = BABYLON.Color3.Blue();

        ground.material = whiteMat;
        sphere1.material = greenMat;
        sphere2.material = redMat;
        sphere3.material = blueMat;

        shadowGenerator.addShadowCaster(sphere1);
        shadowGenerator.addShadowCaster(sphere2);
        shadowGenerator.addShadowCaster(sphere3);

        ground.receiveShadows = true;

        progressiveShadowMap.addMeshes([ground, sphere1, sphere2, sphere3]);
        scene.onReadyObservable.addOnce(() => {
            progressiveShadowMap.render(16);
        });

        return scene;
    }
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
        fill: (area / (width * height)) || 0, // space utilization
    };
}

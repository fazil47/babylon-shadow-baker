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
    private scene: BABYLON.Scene;
    private size: number;
    private enableBlur: boolean;
    private blurIntensity: number;
    private uvRenderTarget: BABYLON.RenderTargetTexture;
    private blurPostProcess?: BABYLON.BlurPostProcess;
    private blurredRenderTargetTexture?: BABYLON.InternalTexture;

    constructor(
        scene: BABYLON.Scene,
        size: number = 512,
        enableBlur: boolean = false,
        blurIntensity: number = 1.0,
    ) {
        this.scene = scene;
        this.size = size;
        this.enableBlur = enableBlur;
        this.blurIntensity = blurIntensity;
        this.uvRenderTarget = new BABYLON.RenderTargetTexture(
            "uvTarget",
            size,
            scene,
            false,
            true,
        );

        if (this.enableBlur) {
            this.setupBlurPostProcess();
        }
    }

    createUVMaterial(originalMaterial: BABYLON.Material): BABYLON.Material {
        const material = originalMaterial.clone(
            "uv_" +
                originalMaterial.name,
        );

        if (!material) {
            throw new Error(
                "Failed to clone material for UV unwrapping.",
            );
        }

        new UVUnwrappingPlugin(material, {});
        return material;
    }

    uv1ToBox(uv: BABYLON.FloatArray, index: number): Box {
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

        // Calculate UV bounds
        let minU = Infinity, maxU = -Infinity;
        let minV = Infinity, maxV = -Infinity;

        for (
            let i = 0;
            i <
                uv.length;
            i += 2
        ) {
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

    boxToUv2(box: Box, containerW: number, containerH: number): Float32Array {
        if (
            !box.originalUv ||
            box.originalUv.length === 0
        ) {
            return new Float32Array(0);
        }

        const uv2 = new Float32Array(box.originalUv.length);

        for (
            let i = 0;
            i <
                box.originalUv.length;
            i += 2
        ) {
            const u = box.originalUv[i];
            const v = box.originalUv[i + 1];

            // Normalize to 0-1 within original bounds
            const normalizedU = (u -
                box.minU) / (box.maxU - box.minU);
            const normalizedV = (v -
                box.minV) / (box.maxV - box.minV);

            // Transform to packed position and normalize by container size
            uv2[i] = (box.x +
                normalizedU * box.w) / containerW;
            uv2[i + 1] = (box.y +
                normalizedV * box.h) / containerH;
        }

        return uv2;
    }

    addMeshes(meshes: BABYLON.AbstractMesh[]): void {
        const boxes = meshes.map((mesh, index) => {
            const uv1 = mesh.getVerticesData(BABYLON.VertexBuffer.UVKind);
            if (uv1) {
                return this.uv1ToBox(
                    uv1,
                    index,
                );
            }

            return null;
        }).filter((box) => box !== null);
        const { w, h } = potpack(boxes); // transform boxes in place

        meshes?.forEach?.((mesh, index) => {
            // Skip UV meshes, debug planes, and invalid meshes
            if (
                !mesh ||
                !mesh.getVerticesData ||
                mesh.name.startsWith("uv_") ||
                mesh.name.includes("debugPlane")
            ) {
                return;
            }

            // Set UV2 coordinates
            const uv2 = this.boxToUv2(boxes[index], w, h);
            mesh.setVerticesData(BABYLON.VertexBuffer.UV2Kind, uv2);

            // Clone mesh for UV rendering
            const uvMesh = mesh.clone("uv_" + mesh.name, null);
            if (uvMesh && mesh.material) {
                uvMesh.material = this.createUVMaterial(mesh.material);

                if (!this.uvRenderTarget.renderList) {
                    this.uvRenderTarget.renderList = [];
                }
                this.uvRenderTarget
                    .renderList.push(uvMesh);
            }
        });
    }

    async render(): Promise<void> {
        if (
            this.uvRenderTarget.renderList &&
            this.uvRenderTarget.renderList.length >
                0
        ) {
            this.uvRenderTarget.render();

            if (
                this.enableBlur &&
                this.blurPostProcess
            ) {
                this.blurredRenderTargetTexture = await BABYLON
                    .ApplyPostProcess(
                        this.blurPostProcess.name,
                        this.uvRenderTarget.getInternalTexture()!,
                        this.scene,
                    );
            }

            this.uvRenderTarget.renderList.forEach((mesh) =>
                mesh.isVisible = false
            );
        }
    }

    getTexture():
        | BABYLON.RenderTargetTexture
        | BABYLON.InternalTexture {
        // Return blurred texture if blur is enabled and available, otherwise return original
        return (this.enableBlur &&
                this.blurredRenderTargetTexture)
            ? this.blurredRenderTargetTexture
            : this.uvRenderTarget;
    }

    getRenderTarget():
        | BABYLON.RenderTargetTexture
        | BABYLON.InternalTexture {
        return this.getTexture();
    }

    private setupBlurPostProcess(): void {
        const kernel = this.blurIntensity * 100.0; // Convert intensity to kernel size
        this.blurPostProcess = new BABYLON.BlurPostProcess(
            "blurPostProcess",
            new BABYLON.Vector2(1.0, 0), // Horizontal blur first
            kernel,
            1.0,
            null,
            BABYLON.Texture.BILINEAR_SAMPLINGMODE,
            this.scene.getEngine(),
        );

        this.blurPostProcess.width = this.size;
        this.blurPostProcess.height = this.size;

        this.blurPostProcess.onApply = (effect: BABYLON.Effect) => {
            effect.setTexture("textureSampler", this.uvRenderTarget);
        };
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
        light.intensity = 2.0;
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
            10.0,
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
        debugMaterial.diffuseTexture = progressiveShadowMap
            .getTexture() as BABYLON.BaseTexture;

        debugMaterial.emissiveTexture = progressiveShadowMap
            .getTexture() as BABYLON.BaseTexture;
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

        const whiteMat = new BABYLON.StandardMaterial("whiteMat", scene);
        whiteMat.diffuseColor = BABYLON.Color3.White();
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

        // Render UV layout
        setTimeout(() => {
            progressiveShadowMap.render();
        }, 500);

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

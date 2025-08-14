import "./style.css";
import * as BABYLON from "@babylonjs/core";
import { Playground } from "./playground";

const main = () => {
    const canvas = document.querySelector<HTMLCanvasElement>("#canvas");

    if (!canvas) {
        console.error("Canvas element not found");
        return;
    }

    const engine = new BABYLON.Engine(canvas, true);
    const scene = Playground.CreateScene(engine, canvas);

    // Render loop
    engine.runRenderLoop(() => {
        scene.render();
    });

    // Handle window resize
    window.addEventListener("resize", () => {
        engine.resize();
    });
};

main();

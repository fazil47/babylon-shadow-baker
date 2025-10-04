import "./style.css";
import * as BABYLON from "@babylonjs/core";
import { Playground } from "./playground";

declare global {
  interface Window {
    scene: BABYLON.Scene | null;
    engine: BABYLON.Engine | null;
    toggleInspector: () => Promise<void>;
  }
}

let engine: BABYLON.Engine | null = null;
let scene: BABYLON.Scene | null = null;
const toggleInspector = async () => {
  const { Inspector } = await import("@babylonjs/inspector");

  if (Inspector.IsVisible) {
    Inspector.Hide();
  } else if (scene) {
    Inspector.Show(scene, { embedMode: true });
  }
};

const main = () => {
  const canvas = document.querySelector<HTMLCanvasElement>("#canvas");

  if (!canvas) {
    console.error("Canvas element not found");
    return;
  }

  engine = new BABYLON.Engine(canvas, true);
  scene = Playground.CreateScene(engine, canvas);

  // Render loop
  engine.runRenderLoop(() => {
    scene?.render();
  });

  // Handle window resize
  window.addEventListener("resize", () => {
    engine?.resize();
  });
};

main();

window.engine = engine;
window.scene = scene;
window.toggleInspector = toggleInspector;

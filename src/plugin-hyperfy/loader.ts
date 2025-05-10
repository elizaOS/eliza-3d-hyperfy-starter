import * as THREE from "three";
import { System } from "./hyperfy/src/core/systems/System.js";
import { createVRMFactory } from "./hyperfy/src/core/extras/createVRMFactory.js";
import { createNode } from "./hyperfy/src/core/extras/createNode.js";
import { GLTFLoader } from "./hyperfy/src/core/libs/gltfloader/GLTFLoader.js";
import { glbToNodes } from "./hyperfy/src/core/extras/glbToNodes.js";
import { createEmoteFactory } from "./hyperfy/src/core/extras/createEmoteFactory.js";
// import { VRMLoaderPlugin } from "@pixiv/three-vrm";
// --- Mock Browser Environment for Loaders ---
// These might need adjustment based on GLTFLoader/VRMLoaderPlugin requirements
if (typeof globalThis !== "undefined") {
  // Mock URL if not globally available or needs specific behavior
  // globalThis.URL = URL; // Usually available in modern Node

  // Mock self if needed by any dependency
  // globalThis.self = globalThis;

  // Mock window minimally
  globalThis.window = globalThis.window || globalThis;

  // Mock document minimally for GLTFLoader
  globalThis.document = globalThis.document || {
    createElementNS: (ns, type) => {
      if (type === "img") {
        // Basic mock for image elements if texture loading is attempted (though we aim to bypass it)
        return {
          src: "",
          onload: () => {},
          onerror: () => {},
        };
      }
      // Default mock for other elements like canvas
      return { style: {} };
    },
    createElement: (type) => {
      if (type === "img") {
        return { src: "", onload: () => {}, onerror: () => {} };
      }
      // Basic canvas mock if needed
      if (type === "canvas") {
        return { getContext: () => null, style: {} };
      }
      return { style: {} }; // Default
    },
    // Add more document mocks if loader errors indicate they are needed
  };

  // Polyfill fetch if using older Node version without native fetch
  // globalThis.fetch = fetch;
}
// --- End Mocks ---

export class AgentLoader extends System {
  promises: Map<any, any>;
  results: Map<any, any>;
  gltfLoader: GLTFLoader;
  dummyScene: any;
  constructor(world) {
    super(world);
    this.promises = new Map();
    this.results = new Map();
    this.gltfLoader = new GLTFLoader();

    // --- Dummy Scene for Hooks ---
    // Create one dummy object to act as the scene target for all avatar loads
    this.dummyScene = new THREE.Object3D();
    this.dummyScene.name = "AgentLoaderDummyScene";
    // -----------------------------

    // --- Attempt to register VRM plugin ---
    // try {
    //     this.gltfLoader.register(parser => new VRMLoaderPlugin(parser, {
    //         autoUpdateHumanBones: false
    //     }));
    //     console.log("[AgentLoader] VRMLoaderPlugin registered.");
    // } catch (vrmError) {
    //     console.error("[AgentLoader] Warning: Failed to register VRMLoaderPlugin. VRM-specific features might be unavailable.", vrmError);
    // }
    // ---------------------------------------
  }

  // --- Dummy Preload Methods ---
  preload(type, url) {
    // No-op for agent
  }
  execPreload() {
    // No-op for agent
    // ClientNetwork calls this after snapshot, so it must exist.
    console.log("[AgentLoader] execPreload called (No-op).");
  }
  // ---------------------------

  // --- Basic Cache Handling ---
  // ... (has, get methods remain the same) ...
  has(type, url) {
    const key = `${type}/${url}`;
    return this.results.has(key) || this.promises.has(key);
  }
  get(type, url) {
    const key = `${type}/${url}`;
    return this.results.get(key);
  }
  // ---------------------------

  resolveUrl(url) {
    // ... (resolveUrl implementation remains the same) ...
    if (typeof url !== "string") {
      console.error(`[AgentLoader] Invalid URL type provided: ${typeof url}`);
      return null;
    }
    if (url.startsWith("asset://")) {
      if (!this.world.assetsUrl) {
        console.error(
          "[AgentLoader] Cannot resolve asset:// URL, world.assetsUrl not set."
        );
        return null;
      }
      const filename = url.substring("asset://".length);
      const baseUrl = this.world.assetsUrl.replace(/[/\\\\]$/, ""); // Remove trailing slash (either / or \)
      return `${baseUrl}/${filename}`;
    }
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return url;
    }
    console.warn(
      `[AgentLoader] Cannot resolve potentially relative URL without base: ${url}`
    );
    return url;
  }

  async load(type, url) {
    const key = `${type}/${url}`;
    if (this.promises.has(key)) return this.promises.get(key);

    const resolved = this.resolveUrl(url);

    const promise = fetch(resolved)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(
            `[AgentLoader] HTTP error ${response.status} for ${resolved}`
          );
        }

        if (type === "model" || type === "avatar" || type === "emote") {
          const arrayBuffer = await response.arrayBuffer();
          return this.parseGLB(type, key, arrayBuffer, resolved);
        }

        // HACK: Only allow loading scripts that create a collider.
        // TODO: Replace with a more robust script validation system.
        if (type === 'script') {
          const code = await response.text();
          
          const hasCollider = /app\.create\(['"]collider['"]\)/.test(code);
          if (!hasCollider) {
            console.warn("Skipping script because it does not create a collider.");
            return;
          }
          
          const script = this.world.scripts.evaluate(code);
          this.results.set(key, script);
          return script;
        }
        
        console.warn(`[AgentLoader] Unsupported type in load(): ${type}`);
        return null;
      })
      .catch((error) => {
        this.promises.delete(key);
        console.error(
          `[AgentLoader] Failed to load ${type} from ${resolved}`,
          error
        );
        throw error;
      });

    this.promises.set(key, promise);
    return promise;
  }

  parseGLB(type, key, arrayBuffer, url) {
    return new Promise((resolve, reject) => {
      this.gltfLoader.parse(
        arrayBuffer,
        "",
        (gltf) => {
          let result;

          if (type === "model") {
            const node = glbToNodes(gltf, this.world);
            result = {
              gltf,
              toNodes() {
                return node.clone(true);
              },
            };
          } else if (type === "emote") {
            const factory = createEmoteFactory(gltf, url);
            result = {
              gltf,
              toClip(options) {
                return factory.toClip(options);
              },
            };
          } else if (type === "avatar") {
            const factory = gltf.userData.vrm ? createVRMFactory(gltf) : null;

            const rootNode = createNode("group", { id: "$root" });
            const avatarNode = createNode("avatar", { id: "avatar", factory });
            rootNode.add(avatarNode);

            result = {
              gltf,
              factory,
              toNodes() {
                return rootNode.clone(true);
              },
            };
          } else {
            return reject(
              new Error(`[AgentLoader] Unsupported GLTF type: ${type}`)
            );
          }

          this.results.set(key, result);
          resolve(result);
        },
        (error) => {
          reject(error);
        }
      );
    });
  }
}

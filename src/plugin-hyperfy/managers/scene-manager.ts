////@ts-nocheck
import fs from 'fs/promises'
import path from 'path'
import puppeteer from 'puppeteer'
import { IAgentRuntime, logger } from '@elizaos/core'
import { HyperfyService } from '../service.js'

export class SceneManager {
  private runtime: IAgentRuntime
  private browser: puppeteer.Browser
  private page: puppeteer.Page
  private loadedItems = new Set<string>()
  private initPromise: Promise<void> | null = null
  private readonly STRIP_SLOTS = [
    'map', 'aoMap', 'alphaMap',
    'bumpMap', 'normalMap',
    'metalnessMap', 'roughnessMap',
    'emissiveMap', 'lightMap'
  ] as const;


  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime
    this.init()
  }

  private async init() {
    // Only initialize once
    if (!this.initPromise) {
      this.initPromise = (async () => {
        this.browser = await puppeteer.launch({
          headless: false,
          defaultViewport: null,
          slowMo: 50
        })

        this.page = await this.browser.newPage()
        const filePath = path.resolve('index.html')
        await this.page.goto(`file://${filePath}`, { waitUntil: 'load' })

        await this.page.waitForFunction(() =>
          window.THREE !== undefined && 
          window.scene !== undefined && 
          window.camera !== undefined &&
          window.loadedModels !== undefined
        )
      })()
    }
    return this.initPromise
  }

  private getService() {
    return this.runtime.getService<HyperfyService>(HyperfyService.serviceType)
  }

  

  async entityAdd(entity: any) {
    await this.init()
    const id = entity.data.id;
    
    const blueprint = entity.world.blueprints.get(entity.data.blueprint)
    if (this.loadedItems.has(id) || !entity?.data) return

    const service = this.getService()
    const world = service.getWorld()
    
    if (!blueprint?.model) return

    const glbHash = blueprint.model.replace('asset://', '')
    const modelUrl = `${world.assetsUrl}/${glbHash}`

    const transform = {
      position: [
        entity.root.position.x,
        entity.root.position.y,
        entity.root.position.z
      ],
      quaternion: [
        entity.root.quaternion.x,
        entity.root.quaternion.y,
        entity.root.quaternion.z,
        entity.root.quaternion.w
      ],
      scale: [
        entity.root.scale.x,
        entity.root.scale.y,
        entity.root.scale.z
      ]
    }

    await this.page.evaluate(async ({ id, modelUrl, transform }) => {
      const loader = new window.GLTFLoader()
      return new Promise<void>((resolve, reject) => {
        loader.load(modelUrl, gltf => {
          const model = gltf.scene
          model.name = id

          model.position.set(...transform.position)
          model.quaternion.set(...transform.quaternion)
          model.scale.set(...transform.scale)

          window.scene.add(model)
          window.loadedModels.set(id, model)
          resolve()
        }, undefined, err => {
          console.error("GLB load error:", err.message || err)
          reject(new Error("GLTF Load failed: " + (err.message || err.type || 'Unknown error')))
        })
      })
    }, { id, modelUrl, transform })

    this.loadedItems.add(id)
  }

  public async start() {
    await this.init()
    const service = this.getService();
    const world = service.getWorld();
    const sceneJson = world.stage.scene.toJSON()

    await this.updatePlayerCamera()
    const STRIP_SLOTS = this.STRIP_SLOTS;
    await this.page.evaluate(async (sceneJson, STRIP_SLOTS) => {
      const loader = new window.THREE.ObjectLoader()
      const loadedScene = loader.parse(sceneJson)

      loadedScene.traverse(obj => {
        if (!obj.isMesh || !obj.material) return;

        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];

        mats.forEach(mat => {
          const id = mat.userData.materialId;
          if (!id) return;

          STRIP_SLOTS.forEach(slot => {
            const key = `${id}:${slot}`;
            const tex = window.texturesMap?.get(key);
            if (tex && tex.isTexture) mat[slot] = tex;
          });

          mat.needsUpdate = true;
        });
      });

      window.scene = loadedScene

      // Ensure renderer updates
      window.renderer.render(window.scene, window.camera)
    }, sceneJson, STRIP_SLOTS)

  }

  async entitiesUpdate() {
    const service = this.getService();
    const world = service.getWorld();
    const entities = world?.entities?.items;
   
    for (const [id, entity] of entities.entries()) {
      if (!entity.root) {
        return;
      }
      if (!this.loadedItems.has(id)) {
        await this.entityAdd(entity)
      }
     
      const transform = {
        position: [
          entity.root.position.x,
          entity.root.position.y,
          entity.root.position.z
        ],
        quaternion: [
          entity.root.quaternion.x,
          entity.root.quaternion.y,
          entity.root.quaternion.z,
          entity.root.quaternion.w
        ],
        scale: [
          entity.root.scale.x,
          entity.root.scale.y,
          entity.root.scale.z
        ]
      }

      // Send to browser to load and place the GLB
      await this.page.evaluate(async ({ id, transform }) => {
        const model = window.loadedModels.get(id);
        
        model.position.set(...transform.position)
        model.quaternion.set(...transform.quaternion)
        model.scale.set(...transform.scale)
      }, { id, transform });
      
    }
  }

  async updatePlayerCamera() {
    const service = this.getService();
    const world = service.getWorld();
    const player = world.entities.player;
    if (!player) {
      return;
    }
    const playerData = {
      position: {
        x: player.base.position.x,
        y: player.base.position.y,
        z: player.base.position.z,
      },
      quaternion: {
        x: player.base.quaternion.x,
        y: player.base.quaternion.y,
        z: player.base.quaternion.z,
        w: player.base.quaternion.w,
      }
    }

    await this.page.evaluate(player => {
      const camera = window.camera
      const position = new window.THREE.Vector3(player.position.x, player.position.y + 1, player.position.z)
      const quaternion = new window.THREE.Quaternion(player.quaternion.x, player.quaternion.y, player.quaternion.z, player.quaternion.w)
      camera.position.copy(position)
      camera.position.y += 2;
      camera.quaternion.copy(quaternion)
    }, playerData)
  }

  // SceneManager.ts
  /**
   * Fully loads a GLB in the browser, bakes textures in, and
   * returns a JSON serialisation that Node can consume without GLTFLoader.
   */
  async loadGlbAsJSON(url: string) {
    await this.init();
    await this.start();
    return this.page.evaluate(async (url) => {
      const loader   = new window.THREE.GLTFLoader();
      const gltf     = await loader.loadAsync(url);

      gltf.scene.traverse(o => {
        if (o.isMesh && o.material) {
          [
            'map','normalMap','metalnessMap','roughnessMap','aoMap',
            'emissiveMap','envMap','specularMap'
          ].forEach(k => { o.material[k] = null; });
        }
      });
      // 1️⃣  We only need plain JS data – convert THREE.Scene to JSON
      const sceneJSON = gltf.scene.toJSON();

      // 2️⃣  Gather extra bits you care about
      return {
        json:  sceneJSON,
        // serialize AnimationClips, VRM flag, whatever you need
        animations: gltf.animations.map(a => a.toJSON()),
        isVRM: !!gltf.userData.vrm
      };
    }, url);
  }

  // SceneManager.ts
  async loadGlbBytes(url: string): Promise<number[]> {
    await this.init();
    const STRIP_SLOTS = this.STRIP_SLOTS;

    return this.page.evaluate(async (url, STRIP_SLOTS) => {
      const loader   = new window.THREE.GLTFLoader();
      const gltf     = await loader.loadAsync(url);

      if (!window.texturesMap) window.texturesMap = new Map();

      gltf.scene.traverse(obj => {
        if (!obj.isMesh || !obj.material) return;

        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];

        mats.forEach(mat => {
          if (!mat.userData.materialId) {
            mat.userData.materialId = window.crypto.randomUUID();
          }
          const id = mat.userData.materialId;

          STRIP_SLOTS.forEach(slot => {
            const tex = mat[slot];
            if (tex && tex.isTexture) {
              window.texturesMap.set(`${id}:${slot}`, tex);  // cache
              mat[slot] = null;                             // strip
            }
          });

          mat.needsUpdate = true;
        });
      });

      const exporter = new window.THREE.GLTFExporter();
      const buffer   = await new Promise<ArrayBuffer>((done) =>
        exporter.parse(gltf.scene, done, { binary: true, embedImages: true })
      );

      // Return a *serialisable* plain array of numbers (0-255)
      return [...new Uint8Array(buffer)];
    }, url, STRIP_SLOTS);
  }

}

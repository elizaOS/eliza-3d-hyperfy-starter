////@ts-nocheck
import path from 'path'
import puppeteer from 'puppeteer'
import { IAgentRuntime, ModelType } from '@elizaos/core'
import { HyperfyService } from '../service.js'

export class PuppeteerManager {
  private static instance: PuppeteerManager | null = null
  
  private runtime: IAgentRuntime
  private browser: puppeteer.Browser
  private page: puppeteer.Page
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

    if (!PuppeteerManager.instance) {
      PuppeteerManager.instance = this
    } else {
      throw new Error('PuppeteerManager has already been instantiated.')
    }
  }

  public static getInstance(): PuppeteerManager {
    if (!this.instance) {
      throw new Error('PuppeteerManager not yet initialized. Call new PuppeteerManager(runtime) first.')
    }
    return this.instance
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
          window.camera !== undefined
        )
      })()
    }
    return this.initPromise
  }

  public async describeScene(): Promise<Record<"front" | "back" | "left" | "right" | "top", { title: string; description: string }>> {
  
    // 1. take screenshots in-memory
    const views = await this.snapshotViews();
  
    // 2. send each view to the IMAGE_DESCRIPTION model
    const entries = await Promise.all(
      (Object.entries(views) as [keyof typeof views, string][]).map(
        async ([name, base64]) => {
          const dataUrl = `data:image/png;base64,${base64}`;
  
          /**  
           *  runtime.useModel will hit the OpenAI plugin you pasted
           *  above.  It accepts either a URL **or** a data-URI, so the
           *  `data:image/png;base64,…` form works out of the box.
           */
          const result = await this.runtime.useModel(ModelType.IMAGE_DESCRIPTION, {
            imageUrl: dataUrl,
            prompt: `You are looking at the ${name} view of a 3-D scene captured from a game engine. Describe what the player can see from this perspective.`
          });
  
          return [name, result as { title: string; description: string }];
        })
    );
  
    // 3. turn the array back into an object and return
    return Object.fromEntries(entries) as any;
  }

  private getService() {
    return this.runtime.getService<HyperfyService>(HyperfyService.serviceType)
  }

  private async rehydrateSceneTextures() {
    const service = this.getService()
    const world = service.getWorld()
    const sceneJson = world.stage.scene.toJSON()

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

  public async snapshotViews(): Promise<Record<string, string>> {
    await this.init();

    const service = this.getService()
    const world = service.getWorld()
    const player = world.entities.player

    if (!player) {
      throw new Error('Player entity not yet available')
    }
    
    await this.rehydrateSceneTextures()

    const playerData = {
      position: player.base.position.toArray(),
      quaternion: [player.base.quaternion.x, player.base.quaternion.y, player.base.quaternion.z, player.base.quaternion.w] as const
    }

    const VIEWS: Array<{ name: 'front' | 'back' | 'left' | 'right' | 'top'; yaw: number; pitch: number }> = [
      { name: 'front',  yaw:   0,            pitch: 0 },
      { name: 'right',  yaw:  -Math.PI / 2,  pitch: 0 },
      { name: 'back',   yaw:   Math.PI,      pitch: 0 },
      { name: 'left',   yaw:   Math.PI / 2,  pitch: 0 },
      { name: 'top',    yaw:   0,            pitch:  Math.PI / 2 }
    ]

    const screenshots: Record<string, string> = {}

    for (const view of VIEWS) {
      await this.page.evaluate(({ playerData, view }) => {
        const win = window as any
        const THREE = win.THREE as typeof import('three')
        const camera   = win.camera as import('three').PerspectiveCamera
        const renderer = win.renderer as import('three').WebGLRenderer

        // ---------------------------------------------
        // Cache initialisation – happens only once
        // ---------------------------------------------
        win.__pmCache = win.__pmCache || {}
        const c = win.__pmCache
        c.eyePos   = c.eyePos   || new THREE.Vector3()
        c.baseQuat = c.baseQuat || new THREE.Quaternion()
        c.viewQuat = c.viewQuat || new THREE.Quaternion()
        c.tmpQuat  = c.tmpQuat  || new THREE.Quaternion()
        c.euler    = c.euler    || new THREE.Euler()

        // ---------------------------------------------
        // Update cached objects with current frame data
        // ---------------------------------------------
        c.eyePos.set(playerData.position[0], playerData.position[1] + 2, playerData.position[2])
        camera.position.copy(c.eyePos)

        c.baseQuat.set(playerData.quaternion[0], playerData.quaternion[1], playerData.quaternion[2], playerData.quaternion[3])
        c.euler.set(view.pitch, view.yaw, 0, 'YXZ')
        c.viewQuat.setFromEuler(c.euler)

        // result = base * view  (store in tmpQuat so baseQuat stays intact)
        c.tmpQuat.copy(c.baseQuat).multiply(c.viewQuat)
        camera.quaternion.copy(c.tmpQuat)

        renderer.render(win.scene, camera)
      }, { playerData, view })

      screenshots[view.name] = await this.page.screenshot({ encoding: 'base64', type: 'png' }) as string
    }

    return screenshots as Record<'front' | 'back' | 'left' | 'right' | 'top', string>
  }

  async loadGlbBytes(url: string): Promise<number[]> {
    await this.init();
    const STRIP_SLOTS = this.STRIP_SLOTS;

    return this.page.evaluate(async (url, STRIP_SLOTS) => {
      const loader = new window.THREE.GLTFLoader();
      const gltf = await loader.loadAsync(url);

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
      const buffer = await new Promise<ArrayBuffer>((done) =>
        exporter.parse(gltf.scene, done, { binary: true, embedImages: true })
      );

      // Return a *serialisable* plain array of numbers (0-255)
      return [...new Uint8Array(buffer)];
    }, url, STRIP_SLOTS);
  }

}

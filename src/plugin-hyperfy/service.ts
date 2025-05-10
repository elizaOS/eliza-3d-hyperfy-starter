import 'ses'

import type { UUID } from '@elizaos/core'
import {
  ChannelType,
  type Content,
  createUniqueUuid,
  EventType,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  Service,
  ModelType,
  composePromptFromState
} from '@elizaos/core'
import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { performance } from 'perf_hooks'
import * as THREE from 'three'
import { createNodeClientWorld } from './hyperfy/src/core/createNodeClientWorld.js'
import { AgentControls } from './controls'
import { AgentLoader } from './loader'
import { Vector3Enhanced } from './hyperfy/src/core/extras/Vector3Enhanced.js'
import { loadPhysX } from './physx/loadPhysX.js'
import { BehaviorManager } from "./behavior-manager.js"
import { EmoteManager } from './emote-manager.js'
import { EMOTES_LIST } from './constants.js'
import { hashFileBuffer } from './utils'

const LOCAL_AVATAR_PATH = process.env.HYPERFY_AGENT_AVATAR_PATH || './avatar.vrm'

const HYPERFY_WS_URL = process.env.WS_URL || 'wss://chill.hyperfy.xyz/ws'
const HYPERFY_TICK_RATE = 50
const HYPERFY_TEST_MODE_MOVE_INTERVAL = 1000
const HYPERFY_TEST_MODE_CHAT_INTERVAL = 5000
const HYPERFY_APPEARANCE_POLL_INTERVAL = 30000
const HYPERFY_ENTITY_UPDATE_INTERVAL = 1000

export class HyperfyService extends Service {
  static serviceType = 'hyperfy'
  capabilityDescription = 'Manages connection and interaction with a Hyperfy world.'

  private world: any | null = null
  private controls: AgentControls | null = null
  private isConnectedState: boolean = false
  private currentEntities: Map<string, any> = new Map()
  private agentState: any = { position: null, rotation: null }
  private tickIntervalId: NodeJS.Timeout | null = null
  private entityUpdateIntervalId: NodeJS.Timeout | null = null
  private wsUrl: string | null = null
  private _currentWorldId: UUID | null = null
  private processedMsgIds: Set<string> = new Set()

  private randomMoveIntervalId: NodeJS.Timeout | null = null
  private randomChatIntervalId: NodeJS.Timeout | null = null
  private currentMoveKey: string | null = null

  private playerNamesMap: Map<string, string> = new Map()
  private appearanceIntervalId: NodeJS.Timeout | null = null
  private appearanceSet: boolean = false
  private nameSet: boolean = false
  private PHYSX: any = null
  private isPhysicsSetup: boolean = false
  private connectionTime: number | null = null
  private emoteHashMap: Map<string, string> = new Map();
  private currentEmoteTimeout: NodeJS.Timeout | null = null;
  private behaviorManager: BehaviorManager;
  private emoteManager: EmoteManager;

  public get currentWorldId(): UUID | null {
    return this._currentWorldId
  }

  public getWorld(): any | null {
    return this.world;
  }

  constructor(protected runtime: IAgentRuntime) {
    super();
    console.info('HyperfyService instance created')
  }

  private entityAddedListener = (entity: any): void => {
    if (!entity || !entity.id) return
    if (entity?.data?.type === 'player' && entity.data.name) {
        if (!this.playerNamesMap.has(entity.id)) {
            console.info(`[Name Map Add] Setting initial name for ID ${entity.id}: '${entity.data.name}'`)
            this.playerNamesMap.set(entity.id, entity.data.name)
        }
    }
    this.currentEntities.set(entity.id, this.extractEntityState(entity))
    console.debug(`[Entity Listener] Added/Updated entity: ${entity.id}`)
  }

  private entityModifiedListener = (entityId: string, changedData: any, entity?: any): void => {
      if (!entityId) return
      const fullEntity = entity || this.world?.entities?.items?.get(entityId)

      if (changedData?.name && fullEntity?.data?.type === 'player') {
          const currentName = this.playerNamesMap.get(entityId)
          if (currentName !== changedData.name) {
              console.info(`[Name Map Update] Updating name for ID ${entityId}: '${changedData.name}'`)
              this.playerNamesMap.set(entityId, changedData.name)
          }
      }
      if (fullEntity) {
        this.currentEntities.set(entityId, this.extractEntityState(fullEntity))
        console.debug(`[Entity Listener] Modified entity: ${entityId}`)
      } else {
        const existing = this.currentEntities.get(entityId)
        if (existing) {
            console.warn(`[Entity Listener] Modified entity ${entityId} but full entity data unavailable.`)
            const potentialNewState = this.extractEntityState({ id: entityId, data: { ...existing, ...changedData } })
            this.currentEntities.set(entityId, potentialNewState)
        } else {
            console.warn(`[Entity Listener] Modified non-tracked entity: ${entityId}`)
        }
      }
  }

  private entityRemovedListener = (entityId: string): void => {
      if (!entityId) return
      if (this.playerNamesMap.has(entityId)) {
          console.info(`[Name Map Update] Removing name for ID ${entityId}`)
          this.playerNamesMap.delete(entityId)
      }
      if(this.currentEntities.delete(entityId)){
        console.debug(`[Entity Listener] Removed entity: ${entityId}`)
      }
  }

  static async start(runtime: IAgentRuntime): Promise<HyperfyService> {
    console.info('*** Starting Hyperfy service ***')
    const service = new HyperfyService(runtime)
    console.info(`Attempting automatic connection to default Hyperfy URL: ${HYPERFY_WS_URL}`)
    const defaultWorldId = createUniqueUuid(runtime, runtime.agentId + '-default-hyperfy') as UUID
    const authToken: string | undefined = undefined

    service
      .connect({ wsUrl: HYPERFY_WS_URL, worldId: defaultWorldId, authToken })
      .then(() => console.info(`Automatic Hyperfy connection initiated.`))
      .catch(err => console.error(`Automatic Hyperfy connection failed: ${err.message}`))

    return service
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    console.info('*** Stopping Hyperfy service ***')
    const service = runtime.getService<HyperfyService>(HyperfyService.serviceType)
    if (service) await service.stop()
    else console.warn('Hyperfy service not found during stop.')
  }

  async connect(config: { wsUrl: string; authToken?: string; worldId: UUID }): Promise<void> {
    if (this.isConnectedState) {
      console.warn(`HyperfyService already connected to world ${this._currentWorldId}. Disconnecting first.`)
      await this.disconnect()
    }

    console.info(`Attempting to connect HyperfyService to ${config.wsUrl} for world ${config.worldId}`)
    this.wsUrl = config.wsUrl
    this._currentWorldId = config.worldId
    this.appearanceSet = false
    this.nameSet = false
    this.isPhysicsSetup = false

    try {
      const world = createNodeClientWorld()
      this.world = world
      ;(world as any).playerNamesMap = this.playerNamesMap

      globalThis.self = globalThis

      this.controls = new AgentControls(world)
      ;(world as any).controls = this.controls
      world.systems.push(this.controls)
      // Temporarily comment out AgentLoader to test for updateTransform error
      const loader = new AgentLoader(world)
      ;(world as any).loader = loader
      world.systems.push(loader);

      // HACK: Overwriting `chat.add` to prevent crashes caused by the original implementation.
      // This ensures safe handling of chat messages and avoids unexpected errors from undefined fields.
      (world as any).chat.add = (msg, broadcast) => {
        const chat = (world as any).chat;
        const MAX_MSGS = 50;
        
        chat.msgs = [...chat.msgs, msg]

        if (chat.msgs.length > MAX_MSGS) {
          chat.msgs.shift()
        }
        for (const callback of chat.listeners) {
          callback(chat.msgs)
        }

        // emit chat event
        const readOnly = Object.freeze({ ...msg })
        this.world.events.emit('chat', readOnly)
        // maybe broadcast
        if (broadcast) {
          this.world.network.send('chatAdded', msg)
        }
      };

      const mockElement = {
        appendChild: () => {},
        removeChild: () => {},
        offsetWidth: 1920,
        offsetHeight: 1080,
        addEventListener: () => {},
        removeEventListener: () => {},
        style: {},
      }

      const hyperfyConfig = {
        wsUrl: this.wsUrl,
        viewport: mockElement,
        ui: mockElement,
        initialAuthToken: config.authToken,
        loadPhysX
      }

      if (typeof this.world.init !== 'function') {
        throw new Error('world.init is not a function')
      }
      await this.world.init(hyperfyConfig)
      console.info('Hyperfy world initialized.')

      console.info("[Hyperfy Connect] World initialized. Setting up listeners, physics, and appearance...")

      if (this.world?.entities && typeof this.world.entities.on === 'function') {
        console.info('[Hyperfy Connect] Attaching entity listeners...')
        this.world.entities.off('entityAdded', this.entityAddedListener.bind(this))
        this.world.entities.off('entityModified', this.entityModifiedListener.bind(this))
        this.world.entities.off('entityRemoved', this.entityRemovedListener.bind(this))

        this.world.entities.on('entityAdded', this.entityAddedListener.bind(this))
        this.world.entities.on('entityModified', this.entityModifiedListener.bind(this))
        this.world.entities.on('entityRemoved', this.entityRemovedListener.bind(this))

        this.currentEntities.clear()
        this.playerNamesMap.clear()
        this.world.entities.items?.forEach((entity: any, id: string) => {
             this.entityAddedListener(entity)
         })
        console.info(`[Hyperfy Connect] Initial entity count: ${this.currentEntities.size}, Player names: ${this.playerNamesMap.size}`)
      } else {
         console.warn("[Hyperfy Connect] world.entities or world.entities.on not available for listener attachment.")
      }

      this.processedMsgIds.clear()
      if (this.world.chat?.msgs) {
        console.info(`Processing ${this.world.chat.msgs.length} existing chat messages.`)
        this.world.chat.msgs.forEach((msg: any) => {
          if (msg && msg.id) {
            this.processedMsgIds.add(msg.id)
          }
        })
        console.info(`Populated ${this.processedMsgIds.size} processed message IDs from history.`)
      }

      this.subscribeToHyperfyEvents()

      this.isConnectedState = true

      this.behaviorManager = new BehaviorManager(this.runtime);
      this.behaviorManager.start();
      
      this.emoteManager = new EmoteManager(world);
      
      this.startSimulation()
      this.startEntityUpdates()

      this.startAppearancePolling()

      this.connectionTime = Date.now(); // Record connection time

      console.info(`HyperfyService connected successfully to ${this.wsUrl}`)
    } catch (error: any) {
      console.error(`HyperfyService connection failed for ${config.worldId} at ${config.wsUrl}: ${error.message}`, error.stack)
      await this.handleDisconnect()
      throw error
    }
  }

  private subscribeToHyperfyEvents(): void {
    if (!this.world || typeof this.world.on !== 'function') {
        console.warn("[Hyperfy Events] Cannot subscribe: World or world.on not available.")
        return
    }

    this.world.off('disconnect')

    this.world.on('disconnect', (reason: string) => {
      console.warn(`Hyperfy world disconnected: ${reason}`)
      this.runtime.emitEvent(EventType.WORLD_LEFT, {
        runtime: this.runtime,
        eventName: 'HYPERFY_DISCONNECTED',
        data: { worldId: this._currentWorldId, reason: reason },
      })
      this.handleDisconnect()
    })

    if (this.world.chat?.subscribe) {
      this.startChatSubscription()
    } else {
        console.warn('[Hyperfy Events] world.chat.subscribe not available.')
    }
  }

  /**
   * Uploads the character's avatar model and associated emote animations,
   * sets the avatar URL locally, updates emote hash mappings,
   * and notifies the server of the new avatar.
   * 
   * This function handles all assets required for character expression and animation.
   */
  private async uploadCharacterAssets(): Promise<{
    success: boolean;
    error?: string;
  }> {
    if (
      !this.world ||
      !this.world.entities?.player ||
      !this.world.network ||
      !this.world.assetsUrl
    ) {
      console.warn(
        "[Appearance] Cannot set avatar: World, player, network, or assetsUrl not ready."
      );
      return { success: false, error: "Prerequisites not met" };
    }

    const agentPlayer = this.world.entities.player;
    const localAvatarPath = path.resolve(LOCAL_AVATAR_PATH);
    let fileName = "";

    try {
      console.info(`[Appearance] Reading avatar file from: ${localAvatarPath}`);
      const fileBuffer: Buffer = await fs.readFile(localAvatarPath);
      fileName = path.basename(localAvatarPath);
      const mimeType = fileName.endsWith(".vrm")
        ? "model/gltf-binary"
        : "application/octet-stream";

      console.info(
        `[Appearance] Uploading ${fileName} (${(fileBuffer.length / 1024).toFixed(2)} KB, Type: ${mimeType})...`
      );

      if (!crypto.subtle || typeof crypto.subtle.digest !== "function") {
        throw new Error(
          "crypto.subtle.digest is not available. Ensure Node.js version supports Web Crypto API."
        );
      }

      const hash = await hashFileBuffer(fileBuffer);
      const ext = fileName.split(".").pop()?.toLowerCase() || "vrm";
      const fullFileNameWithHash = `${hash}.${ext}`;
      const baseUrl = this.world.assetsUrl.replace(/\/$/, "");
      const constructedHttpUrl = `${baseUrl}/${fullFileNameWithHash}`;

      if (typeof this.world.network.upload !== "function") {
        console.warn(
          "[Appearance] world.network.upload function not found. Cannot upload."
        );
        return { success: false, error: "Upload function unavailable" };
      }

      try {
        console.info(
          `[Appearance] Uploading avatar to ${constructedHttpUrl}...`
        );
        const fileForUpload = new File([fileBuffer], fileName, {
          type: mimeType,
        });

        const uploadPromise = this.world.network.upload(fileForUpload);
        const timeoutPromise = new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error("Upload timed out")), 30000)
        );

        await Promise.race([uploadPromise, timeoutPromise]);
        console.info(`[Appearance] Avatar uploaded successfully.`);
      } catch (uploadError: any) {
        console.error(
          `[Appearance] Avatar upload failed: ${uploadError.message}`,
          uploadError.stack
        );
        return {
          success: false,
          error: `Upload failed: ${uploadError.message}`,
        };
      }

      // Apply avatar locally
      if (agentPlayer && typeof agentPlayer.setSessionAvatar === "function") {
        agentPlayer.setSessionAvatar(constructedHttpUrl);
      } else {
        console.warn(
          "[Appearance] agentPlayer.setSessionAvatar not available."
        );
      }

      // Upload emotes
      await this.emoteManager.uploadEmotes();

      // Notify server
      if (typeof this.world.network.send === "function") {
        this.world.network.send("playerSessionAvatar", {
          avatar: constructedHttpUrl,
        });
        console.info(
          `[Appearance] Sent playerSessionAvatar with: ${constructedHttpUrl}`
        );
      } else {
        console.error(
          "[Appearance] Upload succeeded but world.network.send is not available."
        );
      }

      return { success: true };
    } catch (error: any) {
      if (error.code === "ENOENT") {
        console.error(
          `[Appearance] Avatar file not found at ${localAvatarPath}. CWD: ${process.cwd()}`
        );
      } else {
        console.error(
          "[Appearance] Unexpected error during avatar process:",
          error.message,
          error.stack
        );
      }
      return { success: false, error: error.message };
    }
  }


  private startAppearancePolling(): void {
    if (this.appearanceIntervalId) clearInterval(this.appearanceIntervalId);
    // Check if both are already set
    let pollingTasks = { avatar: this.appearanceSet, name: this.nameSet }; // Track tasks locally

    if (pollingTasks.avatar && pollingTasks.name) {
        console.info("[Appearance/Name Polling] Already set, skipping start.");
        return;
    }
    console.info(`[Appearance/Name Polling] Initializing interval every ${HYPERFY_APPEARANCE_POLL_INTERVAL}ms.`);

    
    const f = async () => {
        // Stop polling if both tasks are complete
        if (pollingTasks.avatar && pollingTasks.name) {
            if (this.appearanceIntervalId) clearInterval(this.appearanceIntervalId);
            this.appearanceIntervalId = null;
            console.info(`[Appearance/Name Polling] Both avatar and name set. Polling stopped.`);
            return;
        }

        const agentPlayer = this.world?.entities?.player; // Get player once
        const agentPlayerReady = !!agentPlayer;
        const agentPlayerId = agentPlayer?.data?.id;
        const agentPlayerIdReady = !!agentPlayerId;
        const networkReady = this.world?.network?.id != null;
        const assetsUrlReady = !!this.world?.assetsUrl; // Needed for avatar

        // Condition checks player/ID/network readiness for name, adds assetsUrl for avatar
        console.log('agentPlayerReady', agentPlayerReady)
        console.log('agentPlayerIdReady', agentPlayerIdReady)
        console.log('networkReady', networkReady)
        if (agentPlayerReady && agentPlayerIdReady && networkReady) {
             // --- Set Name (if not already done) ---
             if (!pollingTasks.name) {
                 console.info(`[Name Polling] Player (ID: ${agentPlayerId}), network ready. Attempting name...`);
                 try {
                    await this.changeName(this.runtime.character.name);
                    this.nameSet = true; // Update global state
                    pollingTasks.name = true; // Update local task tracker
                    console.info(`[Name Polling] Initial name successfully set to "${this.runtime.character.name}".`);
                 } catch (error) {
                     console.error(`[Name Polling] Failed to set initial name:`, error);
                 }
             }

             // --- Set Avatar (if not already done AND assets URL ready) ---
             if (!pollingTasks.avatar && assetsUrlReady) {
                 console.info(`[Appearance Polling] Player (ID: ${agentPlayerId}), network, assetsUrl ready. Attempting avatar upload and set...`);
                 const result = await this.uploadCharacterAssets();

                 if (result.success) {
                     this.appearanceSet = true; // Update global state
                     pollingTasks.avatar = true; // Update local task tracker
                     console.info(`[Appearance Polling] Avatar setting process successfully completed.`);
                 } else {
                     console.warn(`[Appearance Polling] Avatar setting process failed: ${result.error || 'Unknown reason'}. Will retry...`);
                 }
             } else if (!pollingTasks.avatar) {
                  console.debug(`[Appearance Polling] Waiting for: Assets URL (${assetsUrlReady})...`);
             }
        } else {
             // Update waiting log
             console.debug(`[Appearance/Name Polling] Waiting for: Player (${agentPlayerReady}), Player ID (${agentPlayerIdReady}), Network (${networkReady})...`);
        }
    }
    this.appearanceIntervalId = setInterval(f, HYPERFY_APPEARANCE_POLL_INTERVAL);
    f();
  }

  private stopAppearancePolling(): void {
    if (this.appearanceIntervalId) {
        clearInterval(this.appearanceIntervalId)
        this.appearanceIntervalId = null
        console.info("[Appearance Polling] Stopped.")
    }
  }

  /**
   * Checks if the service is currently connected to a Hyperfy world.
   */
  public isConnected(): boolean {
    return this.isConnectedState;
  }

  public getEntityById(entityId: string): any | null {
     if (this.currentEntities.has(entityId)) {
        return this.currentEntities.get(entityId)
     }
     return this.world?.entities?.items?.get(entityId) || null
  }

  public getEntityPosition(entityId: string): THREE.Vector3 | null {
      const entityState = this.currentEntities.get(entityId)
      if (entityState?.position && Array.isArray(entityState.position) && entityState.position.length === 3) {
          return new THREE.Vector3(entityState.position[0], entityState.position[1], entityState.position[2])
      }

      const entity = this.world?.entities?.items?.get(entityId)
       if (entity?.base?.position instanceof THREE.Vector3 || entity?.base?.position instanceof Vector3Enhanced) {
            return entity.base.position
       } else if (entity?.data?.position) {
           const pos = entity.data.position
           if (Array.isArray(pos) && pos.length >= 3) {
               return new THREE.Vector3(pos[0], pos[1], pos[2])
           } else if (pos && typeof pos.x === 'number') {
                return new THREE.Vector3(pos.x, pos.y, pos.z)
           }
       }
      return null
  }

   public getEntityName(entityId: string): string | null {
       if (this.playerNamesMap.has(entityId)) {
           return this.playerNamesMap.get(entityId) || null
       }
       const entityState = this.currentEntities.get(entityId)
       if (entityState?.name) {
            return entityState.name
       }
       const entity = this.world?.entities?.items?.get(entityId)
       return entity?.data?.name || null
   }

   private extractEntityState(entity: any): any {
        if (!entity || !entity.id) return null

        let positionArray: number[] | null = null
        if (entity.base?.position instanceof THREE.Vector3) {
            positionArray = entity.base.position.toArray()
        } else if (entity.data?.position) {
            const pos = entity.data.position
            if (Array.isArray(pos) && pos.length >= 3) {
                positionArray = [pos[0], pos[1], pos[2]]
            } else if (pos && typeof pos.x === 'number') {
                 positionArray = [pos.x, pos.y, pos.z]
            }
        }

         let rotationArray: number[] | null = null
         if (entity.base?.quaternion instanceof THREE.Quaternion) {
             rotationArray = entity.base.quaternion.toArray()
         } else if (entity.data?.quaternion) {
             const rot = entity.data.quaternion
              if (Array.isArray(rot) && rot.length >= 4) {
                 rotationArray = [rot[0], rot[1], rot[2], rot[3]]
             } else if (rot && typeof rot.x === 'number') {
                  rotationArray = [rot.x, rot.y, rot.z, rot.w]
             }
         }

        let name: string | null = null
        if (entity.data?.type === 'player' && this.playerNamesMap.has(entity.id)) {
            name = this.playerNamesMap.get(entity.id) || entity.data?.name || null
        } else {
            name = entity.data?.name || null
        }

        const state: any = {
            id: entity.id,
            type: entity.data?.type || 'unknown',
            name: name,
            position: positionArray,
            rotation: rotationArray,
        }

        return state
   }

  async handleDisconnect(): Promise<void> {
      if (!this.isConnectedState && !this.world) return
      console.info('Handling Hyperfy disconnection...')
      this.isConnectedState = false

      this.stopSimulation()
      this.stopEntityUpdates()
      this.stopRandomChatting()
      this.stopAppearancePolling()

      if (this.world?.entities && typeof this.world.entities.off === 'function') {
          console.info("[Hyperfy Cleanup] Removing entity listeners...")
          this.world.entities.off('entityAdded', this.entityAddedListener.bind(this))
          this.world.entities.off('entityModified', this.entityModifiedListener.bind(this))
          this.world.entities.off('entityRemoved', this.entityRemovedListener.bind(this))
      }

      if (this.world) {
          try {
              if (this.world.network && typeof this.world.network.disconnect === 'function') {
                  console.info("[Hyperfy Cleanup] Calling network.disconnect()...")
                  await this.world.network.disconnect()
              }
              if (typeof this.world.destroy === 'function') {
                  console.info("[Hyperfy Cleanup] Calling world.destroy()...")
                  this.world.destroy()
              }
          } catch (e: any) {
              console.warn(`[Hyperfy Cleanup] Error during world network disconnect/destroy: ${e.message}`)
          }
      }

      this.world = null
      this.controls = null
      this.currentEntities.clear()
      this.playerNamesMap.clear()
      this.agentState = { position: null, rotation: null }
      this.wsUrl = null
      this.appearanceSet = false
      this.isPhysicsSetup = false
      this.PHYSX = null

      this.processedMsgIds.clear()

      this.connectionTime = null; // Clear connection time

      if (this.tickIntervalId) { clearTimeout(this.tickIntervalId); this.tickIntervalId = null; }
      if (this.entityUpdateIntervalId) { clearInterval(this.entityUpdateIntervalId); this.entityUpdateIntervalId = null; }
      if (this.randomMoveIntervalId) { clearInterval(this.randomMoveIntervalId); this.randomMoveIntervalId = null; }
      if (this.randomChatIntervalId) { clearInterval(this.randomChatIntervalId); this.randomChatIntervalId = null; }
      if (this.appearanceIntervalId) { clearInterval(this.appearanceIntervalId); this.appearanceIntervalId = null; }

      console.info('Hyperfy disconnection handling complete.')
  }

  async disconnect(): Promise<void> {
      console.info(`Disconnecting HyperfyService from world ${this._currentWorldId}`)
      await this.handleDisconnect()
      console.info('HyperfyService disconnect complete.')
  }

  getState(): { entities: Map<string, any>; agent: any, status: string } {
      const agentStateCopy = this.agentState ? JSON.parse(JSON.stringify(this.agentState)) : {}

      return {
          entities: new Map(this.currentEntities),
          agent: agentStateCopy,
          status: this.isConnectedState ? 'connected' : 'disconnected'
       }
  }

  /**
   * Returns the current map of known entities and their states.
   * The key is the entity ID, the value is the cached entity state.
   * @returns {Map<string, any>} A map of entity IDs to their state objects.
   */
  public getEntities(): Map<string, any> {
      return new Map(this.currentEntities);
  }

  async sendMessage(text: string): Promise<void> {
    if (!this.isConnected() || !this.world?.chat || !this.world?.entities?.player) {
      console.error('HyperfyService: Cannot send message. Not ready.')
      return
    }

    try {
      const agentPlayerId = this.world.entities.player.data.id
      const agentPlayerName = this.getEntityName(agentPlayerId) || this.world.entities.player.data?.name || 'Hyperliza'

      console.info(`HyperfyService sending message: "${text}" as ${agentPlayerName} (${agentPlayerId})`)

      if (typeof this.world.chat.add !== 'function') {
        throw new Error('world.chat.add is not a function')
      }

      this.world.chat.add(
        {
          body: text,
          fromId: agentPlayerId,
          from: agentPlayerName,
        },
        true
      )

    } catch (error: any) {
      console.error('Error sending Hyperfy message:', error.message, error.stack)
      throw error
    }
  }

  async move(key: string, isDown: boolean): Promise<void> {
    if (!this.isConnected() || !this.controls) throw new Error('HyperfyService: Cannot move. Not connected or controls unavailable.')
    if (typeof this.controls.setKey !== 'function') throw new Error('HyperfyService: controls.setKey method is missing.')
    try {
      console.debug(`HyperfyService move: key=${key}, isDown=${isDown}`)
      this.controls.setKey(key, isDown)
    } catch (error: any) {
      console.error('Error setting key:', error.message, error.stack)
      throw error
    }
  }

  /**
   * Simulates using an item by pressing a number key (1-9).
   */
  async useItem(slot: number): Promise<void> {
     if (!this.isConnected() || !this.controls) {
       throw new Error('HyperfyService: Cannot use item. Controls not ready.');
     }
     if (slot < 1 || slot > 9) {
        throw new Error(`HyperfyService: Invalid item slot ${slot}. Must be between 1 and 9.`);
     }
     if (typeof this.controls.setKey !== 'function') {
        throw new Error('HyperfyService: controls.setKey method is missing.');
     }

     const keyName = `key${slot}`;
     console.info(`[Action] Simulating 'Use Item' action (Pressing '${keyName}' briefly)`);

     try {
        this.controls.setKey(keyName, true);
        // Short delay to simulate a press
        await new Promise(resolve => setTimeout(resolve, 100));
        this.controls.setKey(keyName, false);
        console.info(`[Action] 'Use Item' simulation complete (Released '${keyName}').`);
     } catch (error: any) {
        console.error(`[Action] Error during useItem simulation for slot ${slot}:`, error);
        // Attempt to release the key even if there was an error during the wait
        try {
             this.controls.setKey(keyName, false);
        } catch (releaseError) {
             console.error(`[Action] Failed to release ${keyName} key after error:`, releaseError);
        }
        throw error; // Re-throw original error
     }
  }

  /**
   * Changes the agent's display name.
   */
  async changeName(newName: string): Promise<void> {
      if (!this.isConnected() || !this.world?.network || !this.world?.entities?.player) {
          throw new Error('HyperfyService: Cannot change name. Network or player not ready.');
      }
      const agentPlayerId = this.world.entities.player.data.id;
      if (!agentPlayerId) {
          throw new Error('HyperfyService: Cannot change name. Player ID not available.');
      }

      console.info(`[Action] Attempting to change name to "${newName}" for ID ${agentPlayerId}`);

      try {

          // 2. Update local state immediately
          // Update the name map
          if (this.playerNamesMap.has(agentPlayerId)) {
               console.info(`[Name Map Update] Setting name via changeName for ID ${agentPlayerId}: '${newName}'`);
               this.playerNamesMap.set(agentPlayerId, newName);
          } else {
               console.warn(`[Name Map Update] Attempted changeName for ID ${agentPlayerId} not currently in map. Adding.`);
               this.playerNamesMap.set(agentPlayerId, newName);
          }

          // --- Use agentPlayer.modify for local update --- >
          const agentPlayer = this.world.entities.player;
              agentPlayer.modify({ name: newName });
              agentPlayer.data.name = newName

              console.debug(`[Action] Called agentPlayer.modify({ name: "${newName}" })`);

      } catch (error: any) {
          console.error(`[Action] Error during changeName to "${newName}":`, error);
          throw error;
      }
  }

  private startEntityUpdates(intervalMs = HYPERFY_ENTITY_UPDATE_INTERVAL): void {
    if (this.entityUpdateIntervalId) clearInterval(this.entityUpdateIntervalId)

    this.entityUpdateIntervalId = setInterval(() => {
        if (!this.isConnected() || !this.world?.entities?.player) {
             if (this.agentState.position || this.agentState.rotation) {
                 console.debug("[Entity Update] Clearing agent state (disconnected or player missing).")
                 this.agentState = { position: null, rotation: null }
             }
             return
        }

        const playerEntity = this.world.entities.player
        let updated = false
        if (playerEntity?.base?.position instanceof THREE.Vector3) {
             const newPosArray = playerEntity.base.position.toArray()
             if (JSON.stringify(newPosArray) !== JSON.stringify(this.agentState.position)) {
                 this.agentState.position = newPosArray
                 updated = true
             }
        } else if (this.agentState.position) {
             this.agentState.position = null
             updated = true
        }

        if (playerEntity?.base?.quaternion instanceof THREE.Quaternion) {
            const newRotArray = playerEntity.base.quaternion.toArray()
             if (JSON.stringify(newRotArray) !== JSON.stringify(this.agentState.rotation)) {
                 this.agentState.rotation = newRotArray
                 updated = true
             }
        } else if (this.agentState.rotation) {
            this.agentState.rotation = null
             updated = true
        }

    }, intervalMs)
    console.info(`[Entity Update] Started interval for agent state sync every ${intervalMs}ms.`)
  }

  private stopEntityUpdates(): void {
    if (this.entityUpdateIntervalId) {
      clearInterval(this.entityUpdateIntervalId)
      this.entityUpdateIntervalId = null
      console.info('[Entity Update] Stopped.')
    }
  }

  private logCurrentEntities(): void {
     if (!this.world || !this.currentEntities || !this.isConnectedState) return
     const entityCount = this.currentEntities.size
     const agentPlayerId = this.world?.entities?.player?.data?.id

     console.info(`--- [Hyperfy Service Entity Log - Time: ${this.world.time?.toFixed(2)}s] --- (${entityCount} entities) ---`)
     this.currentEntities.forEach((entityState, id) => {
        let logMessage = `  ID: ${id.substring(0,8)}..., Type: ${entityState.type || 'unknown'}`
        const name = entityState.name
        if (name) {
             logMessage += `, Name: ${name}`
             if (id === agentPlayerId) {
                 logMessage += ' (Self)'
             }
        }

        if (entityState.position) {
             const pos = entityState.position.map((p: number) => p.toFixed(2)).join(', ')
             logMessage += `, Pos: (${pos})`
        } else {
            logMessage += `, Pos: (N/A)`
        }
         if (entityState.rotation) {
             const rot = entityState.rotation.map((r: number) => r.toFixed(2))
             logMessage += `, Rot: (x:${rot[0]}, y:${rot[1]}, z:${rot[2]}, w:${rot[3]})`
         } else {
         }

        console.info(logMessage)
     })
     console.info(`--- [End Hyperfy Service Entity Log] ---`)
  }

  /**
   * Finds interactable actions within a certain distance of the agent.
   * @param {number} maxDistance - The maximum distance to search for actions.
   * @returns {Array<object>} A list of interactable actions with id, label, and distance.
   */
  public getInteractableActions(maxDistance: number = 3): Array<{ id: string, label: string, distance: number }> {
      if (!this.world || !this.world.actions || !this.world.entities?.player?.base?.position) {
          logger.warn("[Interactables] Cannot get actions: World, actions system, or player position unavailable.");
          return [];
      }

      const playerPosition = this.world.entities.player.base.position as THREE.Vector3;
      const interactableActions: Array<{ id: string, label: string, distance: number }> = [];

      // world.actions seems to be the registry based on App.js
      if (typeof this.world.actions.getNearby !== 'function') {
          logger.warn("[Interactables] world.actions.getNearby is not a function. Cannot find nearby actions.");
          // Fallback: Iterate manually if getNearby isn't available (less efficient)
          // This assumes world.actions is iterable or has a way to access all actions
          /*
          if (this.world.actions instanceof Map || Array.isArray(this.world.actions)) {
              this.world.actions.forEach((action: any) => {
                 if (action.isAction && action.worldPos) { // Check if it's an Action node
                      const dist = playerPosition.distanceTo(action.worldPos);
                      if (dist <= (action.distance ?? 3) && dist <= maxDistance) {
                          interactableActions.push({
                              id: action.uuid, // Assuming Action node has uuid
                              label: action.label || 'Interact',
                              distance: dist
                          });
                      }
                  }
              });
          } else {
              logger.warn("[Interactables] Cannot iterate world.actions to find nearby actions manually.");
          }
          */
         return []; // Return empty if getNearby isn't available
      }

       // Prefer using world.actions.getNearby if it exists
       const nearbyActions = this.world.actions.getNearby(playerPosition, maxDistance);

      for (const action of nearbyActions) {
         // Ensure the action object has the expected properties
         if (action.node && action.node.isAction && action.node.uuid && action.node.label) {
              interactableActions.push({
                  id: action.node.uuid,
                  label: action.node.label,
                  distance: action.distance
              });
          } else {
              logger.warn("[Interactables] Found nearby action object with unexpected structure:", action);
          }
      }

      logger.debug(`[Interactables] Found ${interactableActions.length} actions within ${maxDistance}m.`);
      return interactableActions;
  }

  async triggerUseAction(holdDurationMs = 600): Promise<void> {
    if (!this.isConnected() || !this.controls) {
      throw new Error('HyperfyService: Cannot trigger use action. Not connected or controls unavailable.')
    }
    if (typeof this.controls.setKey !== 'function') {
        throw new Error('HyperfyService: controls.setKey method is missing.')
    }

    console.info(`[Action] Simulating 'Use' action (Pressing 'E' for ${holdDurationMs}ms)`)

    try {
      this.controls.setKey('keyE', true)

      await new Promise(resolve => setTimeout(resolve, holdDurationMs))

      this.controls.setKey('keyE', false)
      console.info(`[Action] 'Use' action simulation complete (Released 'E').`)

    } catch (error) {
      console.error('[Action] Error during triggerUseAction simulation:', error)
      try {
          if (this.controls && typeof this.controls.setKey === 'function') {
             this.controls.setKey('keyE', false)
          }
      } catch (releaseError) {
          console.error('[Action] Failed to release E key after error:', releaseError)
      }
      throw error
    }
  }

  async stop(): Promise<void> {
    console.info('*** Stopping Hyperfy service instance ***')
    await this.disconnect()
  }

  private startChatSubscription(): void {
    if (!this.world || !this.world.chat) {
      console.error('Cannot subscribe to chat: World or Chat system not available.')
      return
    }

    console.info('[HyperfyService] Initializing chat subscription...')

    // Pre-populate processed IDs with existing messages
    this.world.chat.msgs?.forEach((msg: any) => {
        if (msg && msg.id) { // Add null check for msg and msg.id
            this.processedMsgIds.add(msg.id)
        }
    });

    this.world.chat.subscribe((msgs: any[]) => {
      // Wait for player entity (ensures world/chat exist too)
      if (!this.world || !this.world.chat || !this.world.entities?.player || !this.connectionTime) return

      const agentPlayerId = this.world.entities.player.data.id // Get agent's ID
      const agentPlayerName = this.getEntityName(agentPlayerId) || this.world.entities.player.data?.name || 'Hyperliza'; // Use name getter

      const newMessagesFound: any[] = [] // Temporary list for new messages

      // Step 1: Identify new messages and update processed set
      msgs.forEach((msg: any) => {
        // Check timestamp FIRST - only consider messages newer than connection time
        const messageTimestamp = msg.createdAt ? new Date(msg.createdAt).getTime() : 0;
        if (!messageTimestamp || messageTimestamp <= this.connectionTime) {
            // console.debug(`[Chat Sub] Ignoring historical/old message ID ${msg?.id} (ts: ${messageTimestamp})`);
            // Ensure historical messages are marked processed if encountered *before* connectionTime was set (edge case)
            if (msg?.id && !this.processedMsgIds.has(msg.id.toString())) {
                 this.processedMsgIds.add(msg.id.toString());
            }
            return; // Skip this message
        }

        // Check if we've already processed this message ID (secondary check for duplicates)
        const msgIdStr = msg.id?.toString();
        if (msgIdStr && !this.processedMsgIds.has(msgIdStr)) {
           newMessagesFound.push(msg) // Add the full message object
           this.processedMsgIds.add(msgIdStr) // Mark ID as processed immediately
        }
      })

      // Step 2: Process only the newly found messages
      if (newMessagesFound.length > 0) {
        console.info(`[Chat] Found ${newMessagesFound.length} new messages to process.`)

        newMessagesFound.forEach(async (msg: any) => {
          const senderName = msg.from || 'System'
          const messageBody = msg.body || ''
          console.info(`[Chat Received] From: ${senderName}, ID: ${msg.id}, Body: "${messageBody}"`)

          // Respond only to messages not from the agent itself
          if (msg.fromId !== agentPlayerId) {
              console.info(`[Hyperfy Chat] Processing message from ${senderName}`)

              // First, ensure we register the entity (world, room, sender) in Eliza properly
              const hyperfyWorldId = createUniqueUuid(this.runtime, 'hyperfy-world') as UUID
              const elizaRoomId = createUniqueUuid(this.runtime, this._currentWorldId || 'hyperfy-unknown-world')
              const entityId = createUniqueUuid(this.runtime, msg.fromId.toString()) as UUID

              console.debug(`[Hyperfy Chat] Creating world: ${hyperfyWorldId}`)
              // Register the world if it doesn't exist
              await this.runtime.ensureWorldExists({
                id: hyperfyWorldId,
                name: 'Hyperfy World',
                agentId: this.runtime.agentId,
                serverId: 'hyperfy',
                metadata: {
                  type: 'hyperfy',
                },
              })

              console.debug(`[Hyperfy Chat] Creating room: ${elizaRoomId}`)
              // Register the room if it doesn't exist
              await this.runtime.ensureRoomExists({
                id: elizaRoomId,
                name: 'Hyperfy Chat',
                source: 'hyperfy',
                type: ChannelType.WORLD,
                channelId: this._currentWorldId,
                serverId: 'hyperfy',
                worldId: hyperfyWorldId,
              })

              console.debug(`[Hyperfy Chat] Creating entity connection for: ${entityId}`)
              // Ensure connection for the sender entity
              await this.runtime.ensureConnection({
                entityId: entityId,
                roomId: elizaRoomId,
                userName: senderName,
                name: senderName,
                source: 'hyperfy',
                channelId: this._currentWorldId,
                serverId: 'hyperfy',
                type: ChannelType.WORLD,
                worldId: hyperfyWorldId,
              })

              // Create the message memory
              const messageId = createUniqueUuid(this.runtime, msg.id.toString()) as UUID
              console.debug(`[Hyperfy Chat] Creating memory: ${messageId}`)
              const memory: Memory = {
                id: messageId,
                entityId: entityId,
                agentId: this.runtime.agentId,
                roomId: elizaRoomId,
                worldId: hyperfyWorldId,
                content: {
                  text: messageBody,
                  source: 'hyperfy',
                  channelType: ChannelType.WORLD,
                  metadata: {
                    hyperfyMessageId: msg.id,
                    hyperfyFromId: msg.fromId,
                    hyperfyFromName: senderName,
                  },
                },
                createdAt: Date.now(),
              }

              // Create a callback function to handle responses
              const callback: HandlerCallback = async (responseContent: Content): Promise<Memory[]> => {
                console.info(`[Hyperfy Chat Callback] Received response: ${JSON.stringify(responseContent)}`)
                if (responseContent.text) {
                  console.info(`[Hyperfy Chat Response] ${responseContent.text}`)
                  // Send response back to Hyperfy
                  const emote = await this.pickEmoteForResponse(memory, responseContent.text);
                  if (emote) {
                    this.emoteManager.playEmote(emote);
                  }
                  this.sendMessage(responseContent.text)
              }
                return [];
              };

              // Ensure the entity actually exists in DB before event emission
              try {
                const entity = await this.runtime.getEntityById(entityId)
                if (!entity) {
                  console.warn(
                    `[Hyperfy Chat] Entity ${entityId} not found in database after creation, creating directly`
                  )
                  await this.runtime.createEntity({
                    id: entityId,
                    names: [senderName],
                    agentId: this.runtime.agentId,
                    metadata: {
                      hyperfy: {
                        id: msg.fromId,
                        username: senderName,
                        name: senderName,
                      },
                    },
                  })
                }
              } catch (error) {
                console.error(`[Hyperfy Chat] Error checking/creating entity: ${error}`)
              }

              // Emit the MESSAGE_RECEIVED event to trigger the message handler
              console.info(`[Hyperfy Chat] Emitting MESSAGE_RECEIVED event for message: ${messageId}`)
              await this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
                runtime: this.runtime,
                message: memory,
                callback: callback,
                source: 'hyperfy',
              })

              console.info(`[Hyperfy Chat] Successfully emitted event for message: ${messageId}`)
          }
        })
      }
    })
  }
  private async pickEmoteForResponse(
    receiveMemory: Memory,
    responseText: string
  ): Promise<string | null> {
    const state = await this.runtime.composeState(receiveMemory);
  
    const emoteListText = EMOTES_LIST.map(
      (e) => `- ${e.name}: ${e.description}`
    ).join('\n');
  
    const emotePickPrompt = composePromptFromState({
      state,
      template: `
  # Task: Determine which emote best fits {{agentName}}'s response, based on the character’s personality and intent.
  
  {{providers}}
  
  Guidelines:
  - ONLY pick an emote if {{agentName}}’s response shows a clear emotional tone (e.g. joy, frustration, sarcasm) or strong contextual intent (e.g. celebration, mockery).
  - DO NOT pick an emote for neutral, factual, or generic replies. If unsure, default to "null".
  - Emotes should enhance the meaning or delivery of the message from {{agentName}}’s perspective, not just match keywords.
  - Respond with exactly one emote name (e.g. "crying") if appropriate, or "null" if no emote fits.

  Respond ONLY with one emote name or "null".
  `.trim(),
    });
  
    const emoteResultRaw = await this.runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: emotePickPrompt,
    });
  
    const result = emoteResultRaw?.trim().toLowerCase().replace(/["']/g, '');
  
    if (!result || result === 'null') return null;
  
    const match = EMOTES_LIST.find((e) => e.name.toLowerCase() === result);
    return match ? match.name : null;
  }
  

  private startSimulation(): void {
    if (this.tickIntervalId) clearTimeout(this.tickIntervalId);
    const tickIntervalMs = 1000 / HYPERFY_TICK_RATE;
    let lastTickTime = performance.now();
    let lastTickErrorLogTime = 0; // Track last error log time
    const tickErrorLogInterval = 10000; // Log tick errors max every 10 seconds

    const tickLoop = () => {
      if (!this.world || !this.isConnectedState) {
          // If disconnected or world gone, stop the loop
          if (this.tickIntervalId) {
               console.info('[Sim] Stopping tick loop (world/connection lost).');
               clearTimeout(this.tickIntervalId);
               this.tickIntervalId = null;
          }
          return;
      }

      const now = performance.now();
      try {
        // Wrap in try-catch to handle browser API calls that might fail in Node
        if (typeof this.world.tick === 'function') {
          this.world.tick(now);
        }
      } catch (e: any) { // Type the error
        // Check if it's the specific ReferenceError and log less frequently
        if (e instanceof ReferenceError && e.message?.includes('document is not defined')) {
          if (now - lastTickErrorLogTime > tickErrorLogInterval) {
            console.warn('[HyperfyService] Suppressed frequent ReferenceError during world.tick (document not defined)');
            lastTickErrorLogTime = now;
          }
        } else {
          // Log other errors normally
          console.error('[HyperfyService] Error during world.tick:', e);
        }
        // Don't stop the loop on error, just log and continue
      }

      lastTickTime = now;
      // Schedule next tick precisely
      const elapsed = performance.now() - now;
      const delay = Math.max(0, tickIntervalMs - elapsed);
      // Ensure we don't reschedule if stopSimulation was called during tick
      if (this.tickIntervalId !== null) { // Check if cleared
          this.tickIntervalId = setTimeout(tickLoop, delay);
      }
    };

    console.info(`[HyperfyService] Starting simulation tick at ${HYPERFY_TICK_RATE}Hz.`);
    this.tickIntervalId = setTimeout(tickLoop, 0); // Start immediately
  }

  private stopSimulation(): void {
    if (this.tickIntervalId) {
      clearTimeout(this.tickIntervalId);
      this.tickIntervalId = null; // Set to null immediately
      console.info('[Sim] Tick stopped.');
    }
  }

  private startRandomChatting(): void { /* ... existing ... */ }
  private stopRandomChatting(): void { /* ... existing ... */ }
}

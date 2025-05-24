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
import { AgentControls } from './systems/controls'
import { AgentLoader } from './systems/loader'
import { AgentLiveKit } from './systems/liveKit.js'
import { AgentActions } from './systems/actions.js'
import { Vector3Enhanced } from './hyperfy/src/core/extras/Vector3Enhanced.js'
import { loadPhysX } from './physx/loadPhysX.js'
import { BehaviorManager } from "./managers/behavior-manager.js"
import { EmoteManager } from './managers//emote-manager.js'
import { MessageManager } from './managers//message-manager.js'
import { VoiceManager } from './managers//voice-manager.js'
import { PuppeteerManager } from './managers/puppeteer-manager.js'
import { hashFileBuffer } from './utils'

const LOCAL_AVATAR_PATH = process.env.HYPERFY_AGENT_AVATAR_PATH || './avatar.vrm'

const HYPERFY_WS_URL = process.env.WS_URL || 'wss://chill.hyperfy.xyz/ws'
const HYPERFY_TICK_RATE = 50
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
 
  private playerNamesMap: Map<string, string> = new Map()
  private appearanceIntervalId: NodeJS.Timeout | null = null
  private appearanceSet: boolean = false
  private nameSet: boolean = false
  private connectionTime: number | null = null
  private behaviorManager: BehaviorManager;
  private emoteManager: EmoteManager;
  private messageManager: MessageManager;
  private voiceManager: VoiceManager;
  private puppeteerManager: PuppeteerManager;

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

    try {
      const world = createNodeClientWorld()
      this.world = world;

      (world as any).playerNamesMap = this.playerNamesMap

      globalThis.self = globalThis

      const livekit = new AgentLiveKit(world);
      ;(world as any).livekit = livekit
      world.systems.push(livekit);

      const actions = new AgentActions(world);
      ;(world as any).actions = actions
      world.systems.push(actions);
      
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

      this.emoteManager = new EmoteManager(this.runtime);
      this.messageManager = new MessageManager(this.runtime);
      this.voiceManager = new VoiceManager(this.runtime);
      this.puppeteerManager = new PuppeteerManager(this.runtime);
      this.behaviorManager = new BehaviorManager(this.runtime);
      
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
            const entityId = createUniqueUuid(this.runtime, this.runtime.agentId);
            const entity = await this.runtime.getEntityById(entityId)
            if (entity) {
              entity.metadata.hyperfy = {
                id: agentPlayerId,
                name: agentPlayer?.data?.name,
                userName:agentPlayer?.data?.name
              }
              
              await this.runtime.updateEntity(entity)
            }
            // this.behaviorManager.start();
            this.puppeteerManager.start();
            
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


  async handleDisconnect(): Promise<void> {
      if (!this.isConnectedState && !this.world) return
      console.info('Handling Hyperfy disconnection...')
      this.isConnectedState = false

      this.stopSimulation()
      this.stopEntityUpdates()
      this.stopRandomChatting()
      this.stopAppearancePolling()

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
          
          this.world.network.send('entityModified', { id: agentPlayer.data.id, name: newName })
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
          await this.messageManager.handleMessage(msg);
        })
      }
    })
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

  getEmoteManager() {
    return this.emoteManager;
  }

  getBehaviorManager() {
    return this.behaviorManager;
  }

  getMessageManager() {
    return this.messageManager;
  }

  getVoiceManager() {
    return this.voiceManager;
  }

  getPuppeteerManager() {
    return this.puppeteerManager;
  }
}

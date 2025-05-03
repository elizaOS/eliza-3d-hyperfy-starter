import moment from 'moment'
import { emoteUrls } from '../extras/playerEmotes'
import { readPacket, writePacket } from '../packets'
import { storage } from '../storage'
import { uuid } from '../utils'
import { hashFile } from '../utils-client'
import { System } from './System'

/**
 * Client Network System
 *
 * - runs on the client
 * - provides abstract network methods matching ServerNetwork
 *
 */
export class ClientNetwork extends System {
  constructor(world) {
    super(world)
    this.ids = -1
    this.ws = null
    this.apiUrl = null
    this.id = null
    this.isClient = true
    this.queue = []
  }

  init({ wsUrl, initialAuthToken }) {
    const authToken = initialAuthToken;
    const connectionUrl = (authToken && typeof authToken === 'string') 
                          ? `${wsUrl}?authToken=${encodeURIComponent(authToken)}`
                          : wsUrl;
    this.ws = new WebSocket(connectionUrl);
    this.ws.binaryType = 'arraybuffer';
    this.ws.addEventListener('message', this.onPacket);
    this.ws.addEventListener('close', this.onClose);
  }

  preFixedUpdate() {
    this.flush()
  }

  send(name, data) {
    const packet = writePacket(name, data)
    this.ws.send(packet)
  }

  async upload(fileArg) {
    // --- Determine the actual file data and name --- >
    let fileData;
    let fileName;

    if (typeof fileArg === 'object' && fileArg !== null && fileArg.buffer && fileArg.name) {
        // Node.js case: Extract buffer and name from the wrapper object
        console.log("[ClientNetwork.upload Debug] Handling Node.js buffer wrapper.");
        fileData = fileArg.buffer; // Use the buffer property
        fileName = fileArg.name;
        // Ensure fileData is a Buffer if it isn't already (e.g., if it's an ArrayBuffer)
        if (!(fileData instanceof Buffer) && typeof Buffer !== 'undefined') {
            fileData = Buffer.from(fileData);
        }
    } else {
        // Browser case: Assume fileArg is a File/Blob object
        console.log("[ClientNetwork.upload Debug] Handling Browser File/Blob.");
        fileData = fileArg;
        fileName = fileArg.name;
    }
    // <---------------------------------------------

    {
      // first check if we even need to upload it
      // Pass the extracted fileData (Buffer or Blob) to hashFile
      const hash = await hashFile(fileData)
      // Use the extracted fileName
      const ext = fileName.split('.').pop().toLowerCase()
      const filename = `${hash}.${ext}`
      const url = `${this.apiUrl}/upload-check?filename=${filename}`
      const resp = await fetch(url)
      const data = await resp.json()
      if (data.exists) {
        console.log("[ClientNetwork.upload] Upload check: File already exists", filename);
        return // File already exists
      }
      console.log("[ClientNetwork.upload] Upload check: File does not exist yet", filename);
    }
    // then upload it
    console.log("[ClientNetwork.upload] Creating FormData for upload...");
    const form = new FormData()

    // --- Convert Node Buffer to Blob before appending --- >
    let fileToAppend;
    if (typeof Buffer !== 'undefined' && fileData instanceof Buffer) {
        console.log("[ClientNetwork.upload Debug] Converting Node Buffer to Blob for FormData.");
        // We need the mime type here, get it from the original fileArg if possible
        const mimeType = fileArg?.type || 'application/octet-stream'; // Default if type not passed
        fileToAppend = new Blob([fileData], { type: mimeType });
    } else {
        // Assume fileData is already a Blob/File (browser case)
        fileToAppend = fileData;
    }
    // <--------------------------------------------------

    // Append the Blob (or original File) with the correct name
    form.append('file', fileToAppend, fileName)
    const url = `${this.apiUrl}/upload`
    console.log(`[ClientNetwork.upload] Sending POST request to ${url} with file: ${fileName}`);
    await fetch(url, {
      method: 'POST',
      body: form,
    })
    console.log(`[ClientNetwork.upload] Upload fetch completed for: ${fileName}`);
  }

  enqueue(method, data) {
    this.queue.push([method, data])
  }

  flush() {
    while (this.queue.length) {
      try {
        const [method, data] = this.queue.shift()
        this[method]?.(data)
      } catch (err) {
        console.error(`[ClientNetwork flush] Error executing method: ${err}`);
      }
    }
  }

  getTime() {
    return (performance.now() + this.serverTimeOffset) / 1000 // seconds
  }

  onPacket = e => {
    const [method, data] = readPacket(e.data);
    this.enqueue(method, data);
  }

  onSnapshot(data) {
    this.id = data.id;
    this.serverTimeOffset = data.serverTime - performance.now();
    this.apiUrl = data.apiUrl;
    this.maxUploadSize = data.maxUploadSize;
    this.world.assetsUrl = data.assetsUrl;

    // Skip preload logic for agent, as ClientLoader is not present
    // this.world.loader.preload(...) 
    // this.world.loader.execPreload();

    // Deserialize core world state
    this.world.settings?.deserialize(data.settings);
    this.world.chat?.deserialize(data.chat);
    this.world.blueprints?.deserialize(data.blueprints);
    this.world.entities?.deserialize(data.entities);

    if (this.world.livekit?.deserialize) { // Deserialize for browser client ONLY
        this.world.livekit?.deserialize(data.livekit); 
    }
    
    try {
        storage.set('authToken', data.authToken); 
    } catch (e) {
        console.error("[ClientNetwork onSnapshot] Error calling storage.set:", e); 
    }

    // --> Restore preload logic, guarded for client environment <--
    if (this.world.loader) {
        // preload environment model and avatar
        if (data.settings.model) {
          this.world.loader.preload('model', data.settings.model.url);
        } else if (this.world.environment?.base?.model) { // Check environment exists
          this.world.loader.preload('model', this.world.environment.base.model);
        }
        if (data.settings.avatar) {
          this.world.loader.preload('avatar', data.settings.avatar.url);
        }
        // preload some blueprints
        for (const item of data.blueprints) {
          if (item.preload) {
            if (item.model) {
              const type = item.model.endsWith('.vrm') ? 'avatar' : 'model';
              this.world.loader.preload(type, item.model);
            }
            if (item.script) {
              this.world.loader.preload('script', item.script);
            }
            for (const value of Object.values(item.props || {})) {
              if (value === undefined || value === null || !value?.url || !value?.type) continue;
              this.world.loader.preload(value.type, value.url);
            }
          }
        }
        // preload emotes
        for (const url of emoteUrls) {
          this.world.loader.preload('emote', url);
        }
        // preload local player avatar
        for (const item of data.entities) {
          if (item.type === 'player' && item.owner === this.id) {
            const url = item.sessionAvatar || item.avatar;
            if (url) { // Check if url is valid
                 this.world.loader.preload('avatar', url);
            }
          }
        }
        // Execute preload and emit ready *only* if loader exists
        this.world.loader.execPreload(); 
    } else {
        // Manually emit ready for agent if no loader (restoring previous agent fix)
        this.world.emit('ready', true);
    }
  }

  onSettingsModified = data => {
    this.world.settings.set(data.key, data.value)
  }

  onChatAdded = msg => {
    this.world.chat.add(msg, false)
  }

  onChatCleared = () => {
    this.world.chat.clear()
  }

  onBlueprintAdded = blueprint => {
    this.world.blueprints.add(blueprint)
  }

  onBlueprintModified = change => {
    this.world.blueprints.modify(change)
  }

  onEntityAdded = data => {
    this.world.entities.add(data)
  }

  onEntityModified = data => {
    const entity = this.world.entities.get(data.id)
    if (!entity) return console.error('onEntityModified: no entity found', data)
    entity.modify(data)
  }

  onEntityEvent = event => {
    const [id, version, name, data] = event
    const entity = this.world.entities.get(id)
    entity?.onEvent(version, name, data)
  }

  onEntityRemoved = id => {
    this.world.entities.remove(id)
  }

  onPlayerTeleport = data => {
    this.world.entities.player?.teleport(data)
  }

  onPlayerPush = data => {
    this.world.entities.player?.push(data.force)
  }

  onPlayerSessionAvatar = data => {
    console.log(`[ClientNetwork Debug] Received onPlayerSessionAvatar event with avatar URL: ${data?.avatar}`);
    this.world.entities.player?.setSessionAvatar(data.avatar)
  }

  onPong = time => {
    this.world.stats?.onPong(time)
  }

  onKick = code => {
    this.world.emit('kick', code)
  }

  onClose = code => {
    this.world.chat.add({
      id: uuid(),
      from: null,
      fromId: null,
      body: `You have been disconnected.`,
      createdAt: moment().toISOString(),
    })
    this.world.emit('disconnect', code || true)
    console.log('disconnect', code)
  }
}


import fs from 'fs/promises'
import path from 'path'
import { EMOTES_LIST } from './constants.js'
import { hashFileBuffer } from './utils'
import { logger } from '@elizaos/core'

export class EmoteManager {
  private world: any // replace `any` with more specific type if available
  private emoteHashMap: Map<string, string>
  private currentEmoteTimeout: NodeJS.Timeout | null
  constructor(world) {
    this.world = world
    this.emoteHashMap = new Map()
    this.currentEmoteTimeout = null
  }

  async uploadEmotes() {
    for (const emote of EMOTES_LIST) {
      try {
        const emoteBuffer = await fs.readFile(path.resolve(emote.path));
        const emoteMimeType = "model/gltf-binary";

        const emoteHash = await hashFileBuffer(emoteBuffer);
        const emoteExt = emote.path.split(".").pop()?.toLowerCase() || "glb";
        const emoteFullName = `${emoteHash}.${emoteExt}`;
        const emoteUrl = `asset://${emoteFullName}`;

        console.info(
          `[Appearance] Uploading emote '${emote.name}' as ${emoteFullName} (${(emoteBuffer.length / 1024).toFixed(2)} KB)`
        );

        const emoteFile = new File([emoteBuffer], path.basename(emote.path), {
          type: emoteMimeType,
        });

        const emoteUploadPromise = this.world.network.upload(emoteFile);
        const emoteTimeout = new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error("Upload timed out")), 30000)
        );

        await Promise.race([emoteUploadPromise, emoteTimeout]);

        this.emoteHashMap.set(emote.name, emoteFullName);
        console.info(
          `[Appearance] Emote '${emote.name}' uploaded: ${emoteUrl}`
        );
      } catch (err: any) {
        console.error(
          `[Appearance] Failed to upload emote '${emote.name}': ${err.message}`,
          err.stack
        );
      }
    }
  }

  playEmote(name: string) {
    const hashName = this.emoteHashMap.get(name);
    if (!hashName) {
      console.warn(`[Emote] Emote '${name}' not found.`);
      return;
    }

    const agentPlayer = this.world?.entities?.player;
    if (!agentPlayer) {
      console.warn("[Emote] Player entity not found.");
      return;
    }

    const emoteUrl = `asset://${hashName}`;
    agentPlayer.data.effect = agentPlayer.data.effect || {};
    agentPlayer.data.effect.emote = emoteUrl;

    console.info(`[Emote] Playing '${name}' → ${emoteUrl}`);

    // Clear any existing emote timeout
    if (this.currentEmoteTimeout) {
      clearTimeout(this.currentEmoteTimeout);
      this.currentEmoteTimeout = null;
    }

    // Get duration from EMOTES_LIST
    const emoteMeta = EMOTES_LIST.find(e => e.name === name);
    const duration = emoteMeta?.duration || 1;

    if (duration) {
      this.currentEmoteTimeout = setTimeout(() => {
        if (agentPlayer.data?.effect?.emote === emoteUrl) {
          agentPlayer.data.effect.emote = null;
          console.info(`[Emote] Emote '${name}' cleared after ${duration}s`);
        }
        this.currentEmoteTimeout = null;
      }, duration * 1000);
    } else {
      console.warn(`[Emote] No duration found for '${name}', emote will stay active.`);
    }
  }
}

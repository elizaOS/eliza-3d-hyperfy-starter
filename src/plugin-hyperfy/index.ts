import 'ses';

import type { MessagePayload, Plugin, WorldPayload } from '@elizaos/core';
import {
  EventType,
  logger
} from '@elizaos/core';
import { HyperfyService } from './service';
import { z } from 'zod';
import { hyperfyChatAction } from './actions/chat';
import { hyperfyGotoEntityAction } from './actions/goto';
import { hyperfyUseNearestObjectAction } from './actions/use';
import { hyperfyStopMovingAction } from './actions/stop';
import { hyperfyWalkRandomlyAction } from './actions/walk_randomly';
import { hyperfyProvider } from './providers/world';
import { hyperfyEmoteProvider } from './providers/emote';

// --- Hardcoded values matching agent/index.mjs ---
const HYPERFY_WS_URL = process.env.WS_URL || 'wss://chill.hyperfy.xyz/ws'
// ---------------------------------------------


// Define the plugin configuration schema (optional, adjust as needed)
// Renamed this one to avoid conflict
const hyperfyPluginConfigSchema = z.object({
  DEFAULT_HYPERFY_WS_URL: z.string().url().optional(),
  DEFAULT_TICK_RATE: z.coerce.number().positive().optional().default(50), // Added TICK_RATE config
});

// --- Main Plugin Definition ---
export const hyperfyPlugin: Plugin = {
  name: 'hyperfy', // Renamed plugin
  description: 'Integrates ElizaOS agents with Hyperfy worlds',
  config: {
    // Map environment variables to config keys
    DEFAULT_HYPERFY_WS_URL: process.env.DEFAULT_HYPERFY_WS_URL,
    DEFAULT_TICK_RATE: process.env.DEFAULT_TICK_RATE,
  },
  async init(config: Record<string, string | undefined>) {
    logger.info('*** Initializing Hyperfy Integration plugin ***');
    try {
      // Validate config using the schema
      const validatedConfig = await hyperfyPluginConfigSchema.parseAsync(config);
      logger.info('Hyperfy plugin config validated:', validatedConfig);
      // Store validated config for service use (runtime.pluginConfigs is usually the way)
    } catch (error) {
      if (error instanceof z.ZodError) {
        logger.error(`Invalid Hyperfy plugin configuration: ${error.errors.map((e) => e.message).join(', ')}`);
        // Decide if this is a fatal error
        // throw new Error(`Invalid Hyperfy plugin configuration...`);
      } else {
         logger.error('Unknown error during Hyperfy plugin init:', error);
        // throw error;
      }
      // Allow initialization to continue even if config fails, service might get config later
    }
  },
  // Removed example models, tests, routes
  events: {
    // Define how a Hyperfy world connection is triggered and handled
    WORLD_CONNECTED: [
      async (payload: WorldPayload) => {
        // **Decision Point:** How do we know this payload represents a Hyperfy world?
        // Option 1: Check payload.source
        // Option 2: Check world metadata (e.g., payload.world.metadata?.type === 'hyperfy')
        // Option 3: Check world settings associated with payload.world.id
        const isHyperfy = payload.source === 'hyperfy' || payload.world?.metadata?.type === 'hyperfy'; // Example check

        if (isHyperfy) {
            logger.info(`Hyperfy WORLD_CONNECTED event received for world: ${payload.world.id}`);
            const runtime = payload.runtime;
            const service = runtime.getService<HyperfyService>(HyperfyService.serviceType);

            // Get connection details (WS URL, Auth Token)
            // Prioritize metadata, then maybe check runtime settings/config as fallback
            const wsUrl = payload.world.metadata?.wsUrl as string || HYPERFY_WS_URL; // Use default if not in metadata
            const authToken = payload.world.metadata?.authToken as string | undefined; // Optional
            const worldId = payload.world.id;

            if (service && worldId) {
                try {
                    await service.connect({ wsUrl, authToken, worldId });
                    logger.info(`Successfully initiated Hyperfy connection for world ${worldId}`);
                } catch(error) {
                     logger.error(`Failed to connect Hyperfy service for world ${worldId}:`, error);
                     // Optionally notify user/admin through a callback or another event
                }
            } else {
                logger.error(`Missing required info (service, worldId) to connect Hyperfy service for world ${payload.world.id}`);
            }
        } else {
             logger.debug(`Ignoring WORLD_CONNECTED event, source is not Hyperfy: ${payload.source}`);
        }
      },
    ],
    // Handle disconnect events
    WORLD_DISCONNECTED: [
       async (payload: WorldPayload) => {
           const isHyperfy = payload.source === 'hyperfy' || payload.world?.metadata?.type === 'hyperfy'; // Check if it was a Hyperfy world

           if (isHyperfy && payload.world?.id) {
                logger.info(`Hyperfy WORLD_DISCONNECTED event for world: ${payload.world.id}`);
                const runtime = payload.runtime;
                const service = runtime.getService<HyperfyService>(HyperfyService.serviceType);

                // Only disconnect if the service is currently connected to *this* world
                if (service?.isConnected() && service.currentWorldId === payload.world.id) {
                    await service.disconnect();
                    logger.info(`Hyperfy service disconnected for world ${payload.world.id}`);
                } else {
                     logger.warn(`Received disconnect for Hyperfy world ${payload.world.id}, but service was not connected or connected to a different world.`);
                }
           }
       }
     ],
     // Add a handler for MESSAGE_RECEIVED that passes through to messageReceivedHandler
     [EventType.MESSAGE_RECEIVED]: [
        async (payload: MessagePayload) => {
          try {
            // Only handle messages that originated from Hyperfy
            const metadata = payload.message.content.metadata;
            if (payload.source === 'hyperfy' && 
                metadata && 
                typeof metadata === 'object' &&
                'hyperfyMessageId' in metadata) {
              
              logger.info(`[Hyperfy Plugin] Processing MESSAGE_RECEIVED event for message: ${payload.message.id}`);
              
              // Message will be handled by the callback mechanism in startChatSubscription
              // but we can add any additional processing here if needed
              
              // Note: most of the logic for routing messages back to Hyperfy happens in the callback
              // that was registered when the message was created
            }
          } catch (error) {
            logger.error(`[Hyperfy Plugin] Error handling MESSAGE_RECEIVED event: ${error}`);
          }
        }
     ]
  },
  services: [
      HyperfyService // Register the Hyperfy service
  ],
  actions: [
      hyperfyChatAction,
      hyperfyGotoEntityAction,
      hyperfyUseNearestObjectAction,
      hyperfyStopMovingAction,
      hyperfyWalkRandomlyAction
  ],
  providers: [
      hyperfyProvider, // Register the Hyperfy provider
      hyperfyEmoteProvider
  ],
};

export default hyperfyPlugin;

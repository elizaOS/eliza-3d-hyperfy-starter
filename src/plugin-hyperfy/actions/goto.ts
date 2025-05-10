import {
    type Action,
    composePromptFromState,
    ModelType,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
    logger,
    EventType,
    type EventHandler
} from '@elizaos/core';
import { HyperfyService } from '../service';
import { AgentControls } from '../controls'; // Import AgentControls type
// Import THREE types if needed, e.g., for metadata typing
// import type * as THREE from 'three';

// Define a simple template for entity extraction
const entityExtractionTemplate = `
# Task: Identify the target Hyperfy Entity ID based on the user message and the Hyperfy World State.
# Do NOT use person IDs. Use only the Hyperfy Entity IDs listed in the Hyperfy World State.

{{providers}}
# Instructions: Examine the user message: "{{messageText}}". Identify the Hyperfy Entity ID the user wants to navigate to from the list of entities provided in the context. Respond with only the Hyperfy Entity ID.

Response format should be a valid JSON block like this:
\`\`\`json
{
    "entityId": "<string>" // The ID of the target entity, or null if none is clearly specified
}
\`\`\`

Your response should include the valid JSON block and nothing else.
`;

export const hyperfyGotoEntityAction: Action = {
    name: 'HYPERFY_GOTO_ENTITY',
    similes: ['GO_TO_ENTITY_IN_WORLD', 'MOVE_TO_ENTITY', 'NAVIGATE_TO_ENTITY'],
    description: 'Navigates the agent to the specified entity ID within the connected Hyperfy world using the AgentControls system.',
    validate: async (runtime: IAgentRuntime): Promise<boolean> => {
      const service = runtime.getService<HyperfyService>(HyperfyService.serviceType);
      // Check if connected and if controls are available
      return !!service && service.isConnected() && !!service.getWorld()?.controls;
    },
    handler: async (
      runtime: IAgentRuntime,
      message: Memory,
      _state: State,
      options: { entityId?: string },
      callback: HandlerCallback
    ) => {
      const service = runtime.getService<HyperfyService>(HyperfyService.serviceType);
      const world = service?.getWorld(); // Use the getter
      const controls = world?.controls as AgentControls | undefined; // Get controls and cast type

      if (!service || !world || !controls) {
        logger.error('[GOTO Action] Hyperfy service, world, or controls not found.');
        await callback({ thought: 'Prerequisites failed.', error: "Cannot navigate. Hyperfy connection/controls unavailable." });
        return;
      }
      
      let targetEntityId: string | undefined = options?.entityId;

      // If entityId wasn't provided in options, try to extract it from the message
      if (!targetEntityId) {
          logger.info('[GOTO Action] No entityId in options, attempting extraction from message...');
          try {
              // Compose state including entities provider
              const extractionState = await runtime.composeState(message, ['ENTITIES', 'RECENT_MESSAGES']);

              const prompt = composePromptFromState({
                  state: extractionState,
                  template: entityExtractionTemplate,
              });

              console.log("prompt", prompt);

              // Use OBJECT_SMALL model for structured response
              const response = await runtime.useModel(ModelType.OBJECT_SMALL, { prompt });

              if (response && response.entityId && typeof response.entityId === 'string') {
                  targetEntityId = response.entityId;
                   logger.info(`[GOTO Action] Extracted entityId: ${targetEntityId}`);
              } else {
                   logger.warn('[GOTO Action] Could not extract entityId from message via LLM.', response);
              }

          } catch (error) {
              logger.error(`[GOTO Action] Error during entityId extraction: ${error}`);
              // Proceed without targetEntityId, error handled below
          }
      }

      // Final check if we have a target entity ID
      if (!targetEntityId) {
          logger.error('[GOTO Action] No target entity ID specified either in options or extracted from message.');
          await callback({ thought: 'Action failed: No target entity ID.', text: "Action failed: No target entity ID specified.", metadata: { error: 'missing_entity_id' } });
          return;
      }

      try {
        const targetPosition = service.getEntityPosition(targetEntityId);

        if (!targetPosition) {
            const targetName = service.getEntityName(targetEntityId);
            const errorMsg = `Error: Cannot navigate. Could not find location for entity ${targetName || targetEntityId}.`;
            logger.error(`HYPERFY_GOTO_ENTITY: ${errorMsg}`);
            await callback({ text: errorMsg, metadata: { error: 'entity_not_found', targetEntityId: targetEntityId } });
            return;
        }

        // Stop any previous movement first
        controls.stopNavigation("goto action request");

        // Tell the controls system to start navigating to the single target
        const targetName = service.getEntityName(targetEntityId);
        logger.info(`HYPERFY_GOTO_ENTITY: Requesting navigation via controls to entity ${targetName || targetEntityId} at (${targetPosition.x.toFixed(2)}, ${targetPosition.z.toFixed(2)})`);
        controls.navigateTo(targetPosition.x, targetPosition.z); // Use controls method

        // Provide initial confirmation
        await callback({
           text: `Navigating towards ${targetName || `entity ${targetEntityId}`}...`,
           actions: ['HYPERFY_GOTO_ENTITY'],
           source: 'hyperfy',
           metadata: {
               targetEntityId: targetEntityId,
               targetPosition: targetPosition.toArray(),
               status: 'navigation_started'
           }
        });

      } catch (error: any) {
        logger.error(`Error during HYPERFY_GOTO_ENTITY for ID ${targetEntityId}:`, error);
        await callback({ text: `Error starting navigation: ${error.message}`, metadata: { error: 'navigation_start_failed' } });
      }
    },
     examples: [
      // Example assumes an entity "Bob" exists with ID "entity123"
      [
        { name: '{{name1}}', content: { text: 'Go to Bob' } }, // LLM should infer/find ID or user provides via options
        { name: '{{name2}}', content: { text: 'Navigating towards Bob...', actions: ['HYPERFY_GOTO_ENTITY'], source: 'hyperfy' } } // Removed metadata
      ],
       [
        { name: '{{name1}}', content: { text: 'Find entity abcdef' } }, // Assuming entity abcdef exists
        { name: '{{name2}}', content: { text: 'Navigating towards entity abcdef...', actions: ['HYPERFY_GOTO_ENTITY'], source: 'hyperfy' } } // Removed metadata
      ],
      // Example for failure (entity not found)
      [
        { name: '{{name1}}', content: { text: 'Go to the missing chair' } }, // User might specify ID in options
        { name: '{{name2}}', content: { text: 'Error: Cannot navigate. Could not find location for entity chair999.' } } // Assuming ID was chair999
      ]
     ]
  }; 
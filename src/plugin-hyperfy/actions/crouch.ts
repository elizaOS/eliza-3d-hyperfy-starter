import {
    logger,
    type Action,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State
} from '@elizaos/core';
import { AgentControls } from '../controls';
import { HyperfyService } from '../service';

export const hyperfyCrouchAction: Action = {
    name: 'HYPERFY_CROUCH',
    similes: ['DUCK', 'SQUAT', 'KNEEL', 'BEND_DOWN', 'STAND_UP'],
    description: 'Toggles the agent between crouching and standing positions.',
    validate: async (runtime: IAgentRuntime): Promise<boolean> => {
      const service = runtime.getService<HyperfyService>(HyperfyService.serviceType);
      return !!service && service.isConnected() && !!service.getWorld()?.controls;
    },
    handler: async (
      runtime: IAgentRuntime,
      _message: Memory,
      _state: State,
      options: { command?: 'toggle' | 'crouch' | 'stand' },
      callback: HandlerCallback
    ) => {
      const service = runtime.getService<HyperfyService>(HyperfyService.serviceType);
      const world = service?.getWorld();
      const controls = world?.controls as AgentControls | undefined;

      if (!service || !world || !controls) {
        logger.error('Hyperfy service, world, or controls not found for HYPERFY_CROUCH action.');
        await callback({ text: "Error: Cannot crouch. Hyperfy connection/controls unavailable." });
        return;
      }

      if (typeof controls.toggleCrouch !== 'function' || typeof controls.getIsCrouching !== 'function') {
        logger.error('AgentControls missing crouch methods.');
        await callback({ text: "Error: Crouch functionality not available in controls." });
        return;
      }

      const command = options?.command || 'toggle';
      const isCrouching = controls.getIsCrouching();
      
      // Handle different command options
      if (command === 'crouch' && isCrouching) {
        await callback({ text: "Already crouching.", source: 'hyperfy' });
        return;
      } else if (command === 'stand' && !isCrouching) {
        await callback({ text: "Already standing.", source: 'hyperfy' });
        return;
      }
      
      // Execute the crouch toggle
      controls.toggleCrouch();
      
      // Determine the new state after toggling
      const newState = controls.getIsCrouching();
      const statusText = newState ? "Crouching down." : "Standing up.";
      
      await callback({ 
        text: statusText, 
        actions: ['HYPERFY_CROUCH'], 
        source: 'hyperfy', 
        metadata: { status: newState ? 'crouching' : 'standing' } 
      });
    },
    examples: [
      [
        { name: '{{name1}}', content: { text: 'Crouch down.' } },
        { name: '{{name2}}', content: { text: 'Crouching down.', actions: ['HYPERFY_CROUCH'], source: 'hyperfy' } }
      ],
      [
        { name: '{{name1}}', content: { text: 'Stand up.' } },
        { name: '{{name2}}', content: { text: 'Standing up.', actions: ['HYPERFY_CROUCH'], source: 'hyperfy' } }
      ],
      [
        { name: '{{name1}}', content: { text: 'Duck behind this.' } },
        { name: '{{name2}}', content: { text: 'Crouching down.', actions: ['HYPERFY_CROUCH'], source: 'hyperfy' } }
      ]
    ]
}; 
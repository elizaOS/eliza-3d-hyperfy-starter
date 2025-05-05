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

export const hyperfyJumpAction: Action = {
    name: 'HYPERFY_JUMP',
    similes: ['LEAP', 'HOP', 'BOUNCE', 'JUMP_UP'],
    description: 'Makes the agent perform a jump.',
    validate: async (runtime: IAgentRuntime): Promise<boolean> => {
      const service = runtime.getService<HyperfyService>(HyperfyService.serviceType);
      return !!service && service.isConnected() && !!service.getWorld()?.controls;
    },
    handler: async (
      runtime: IAgentRuntime,
      _message: Memory,
      _state: State,
      options: { height?: number },
      callback: HandlerCallback
    ) => {
      const service = runtime.getService<HyperfyService>(HyperfyService.serviceType);
      const world = service?.getWorld();
      const controls = world?.controls as AgentControls | undefined;

      if (!service || !world || !controls) {
        logger.error('Hyperfy service, world, or controls not found for HYPERFY_JUMP action.');
        await callback({ text: "Error: Cannot jump. Hyperfy connection/controls unavailable." });
        return;
      }

      if (typeof controls.jump !== 'function') {
        logger.error('AgentControls missing jump method.');
        await callback({ text: "Error: Jump functionality not available in controls." });
        return;
      }

      if (controls.getIsJumping()) {
        await callback({ text: "Already jumping.", source: 'hyperfy' });
        return;
      }

      // Perform the jump
      controls.jump();
      await callback({ 
        text: "Jumping!", 
        actions: ['HYPERFY_JUMP'], 
        source: 'hyperfy', 
        metadata: { status: 'executed' } 
      });
    },
    examples: [
      [
        { name: '{{name1}}', content: { text: 'Jump over this.' } },
        { name: '{{name2}}', content: { text: 'Jumping!', actions: ['HYPERFY_JUMP'], source: 'hyperfy' } }
      ],
      [
        { name: '{{name1}}', content: { text: 'Hop up and down.' } },
        { name: '{{name2}}', content: { text: 'Jumping!', actions: ['HYPERFY_JUMP'], source: 'hyperfy' } }
      ]
    ]
}; 
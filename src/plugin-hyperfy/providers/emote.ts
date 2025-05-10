import {
    type Provider,
    type IAgentRuntime,
    type Memory,
} from '@elizaos/core'
import { EMOTES_LIST } from '../constants'
  
/**
 * A provider that lists all available emotes with descriptions.
 * @type {Provider}
 */
export const hyperfyEmoteProvider: Provider = {
    name: 'EMOTE_LIST',
    description: 'Lists all available emotes and their descriptions',
    get: async (_runtime: IAgentRuntime, _message: Memory) => {
      const emoteListText = EMOTES_LIST.map(
        (e) => `- **${e.name}**: ${e.description}`
      ).join('\n');
  
      const text = `\n\n# Available Emotes\n\n${emoteListText}\n\n`;
  
      return {
        data: {
          emotes: EMOTES_LIST,
        },
        values: {
          emoteListText,
        },
        text,
      };
    },
};
  
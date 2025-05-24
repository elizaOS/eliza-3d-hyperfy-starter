import {
  type Action,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
  composePromptFromState,
  ModelType,
  parseKeyValueXml,
  type Content,
} from '@elizaos/core';
import { HyperfyService } from '../service';

const describeTemplate = (viewSummary) =>`
<task>
You are {{agentName}} inside a virtual world. Based on the provided world state and five directional views, generate a grounded speculative description of your surroundings.
</task>

<providers>
{{bio}}

---

{{system}}

---

{{messageDirections}}

---

# View Directions:
The five views are relative to the agent's current position and orientation:
- **Front**: What is directly ahead of the agent.
- **Back**: Behind the agent.
- **Left**: To the agent's left.
- **Right**: To the agent's right.
- **Top**: Overhead or above the current space.

# View Summaries:
${viewSummary}

# World State:
Use knowledge of nearby entities, their positions, and the agent's appearance from the Hyperfy world state to **speculate and enrich the description** as if the agent truly perceives the space.

</providers>

---

{{hyperfyStatus}}

<keys>
"thought" - A short internal thought reflecting what the agent is mentally processing or planning.
"emote" - A single appropriate emote (e.g., "wave", "worried") or blank if none fits.
"text" - What the agent will say aloud to others, based on what they 'see'.
</keys>

<instructions>
Use this exact XML format in your response:

<response>
  <thought>...</thought>
  <text>...</text>
  <emote>...</emote>
</response>

Stay concise, descriptive, and immersive. No commentary outside the <response> block.
</instructions>
`;

function formatViewSummary(views: Record<string, { title?: string; description?: string }>): string {
  const directionLabels: Record<string, string> = {
    front: 'Front View',
    back: 'Back View',
    left: 'Left View',
    right: 'Right View',
    top: 'Top View',
  };

  return Object.entries(views)
    .map(([key, view]) => {
      const label = directionLabels[key] || key;
      const desc = view?.description?.trim() || 'No description available.';
      return `- **${label}**:\n${desc}`;
    })
    .join('\n\n');
}


export const hyperfyDescribeSurroundingsAction: Action = {
  name: 'HYPERFY_DESCRIBE_SURROUNDINGS',
  similes: [
    'LOOK_AROUND',
    'WHAT_AROUND',
    'HOW_DO_I_LOOK',
    'OBSERVE_AREA',
    'DESCRIBE_SURROUNDINGS',
  ],
  description:
    'Captures camera views and world state to describe nearby objects and environment concisely.',
  validate: async (runtime: IAgentRuntime) => {
    const service = runtime.getService<HyperfyService>(HyperfyService.serviceType);
    return !!service && service.isConnected();
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _opts: Record<string, never>,
    callback: HandlerCallback
  ) => {
    const service = runtime.getService<HyperfyService>(HyperfyService.serviceType);
    const pm = service?.getPuppeteerManager();
    const world = service?.getWorld();
    const player = world?.entities?.player;

    if (!service || !world || !player) {
      logger.warn('[DESCRIBE] Missing world or player entity.');
      await callback({
        text: 'Sorry, I cannot perceive the surroundings right now.',
        metadata: { error: 'missing_world_or_player' },
      });
      return;
    }

    let views;
    try {
      views = await pm.describeScene();
    } catch (err) {
      logger.error('[DESCRIBE] Scene capture failed:', err);
      await callback({
        text: 'I tried to look around, but my vision failed.',
        metadata: { error: 'describe_scene_failed' },
      });
      return;
    }

    console.log("viewwssssssssss", views);

    const viewSummary = formatViewSummary(views);

    state = await runtime.composeState(message);

    const prompt = composePromptFromState({
      state,
      template: describeTemplate(viewSummary),
    });

    console.log("promtptptptptptpt", prompt)

    let response: string;
    try {
      response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
    } catch (err) {
      logger.error('[DESCRIBE] Model call failed:', err);
      await callback({
        text: 'I couldn’t generate a description just now.',
        metadata: { error: 'model_failure' },
      });
      return;
    }

    const parsed = parseKeyValueXml(response);

    console.log("parseeeee", parsed);

    const finalResponse: Content = {
      text: parsed.text || 'There’s not much I can see.',
      thought: parsed.thought,
      actions: ['HYPERFY_DESCRIBE_SURROUNDINGS'],
      source: 'hyperfy',
    };

    if (parsed.emote) {
      finalResponse.emote = parsed.emote;
    }

    await callback(finalResponse);
  },

  examples: [
    [
      { name: '{{name1}}', content: { text: 'What do you see around us?' } },
      { name: '{{name2}}', content: { text: 'We’re in a cobblestone courtyard…', actions: ['HYPERFY_DESCRIBE_SURROUNDINGS'], source: 'hyperfy' } },
    ],
    [
      { name: '{{name1}}', content: { text: 'How do I look?' } },
      { name: '{{name2}}', content: { text: 'You’re wearing a red explorer’s jacket and a bronze helmet…', actions: ['HYPERFY_DESCRIBE_SURROUNDINGS'], source: 'hyperfy' } },
    ],
    [
      { name: '{{name1}}', content: { text: 'Anything interesting nearby?' } },
      { name: '{{name2}}', content: { text: 'There’s a glowing blue crystal just a few steps to your right…', actions: ['HYPERFY_DESCRIBE_SURROUNDINGS'], source: 'hyperfy' } },
    ],
  ],
};

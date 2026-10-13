import Anthropic from '@anthropic-ai/sdk';
import { ASSESSMENT_INSTRUCTIONS, ASSESSMENT_JSON_SCHEMA, type AssessmentProvider } from './drafting-assessment';

// Models that accept server-side refusal fallbacks; Haiku has none.
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

export function anthropicProvider(apiKey: string, model: string, client = new Anthropic({ apiKey, maxRetries: 1 })): AssessmentProvider {
  return {
    provider: 'anthropic',
    model,
    assess: async (request) => {
      const fallback = FALLBACK_MODELS.has(model);
      const response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        // A bounded, single-step judgment: low effort keeps it quick and inexpensive.
        output_config: { effort: 'low', format: { type: 'json_schema', schema: ASSESSMENT_JSON_SCHEMA } },
        system: ASSESSMENT_INSTRUCTIONS,
        messages: [{ role: 'user', content: JSON.stringify(request) }],
      });
      if (response.stop_reason === 'refusal') throw new Error('Claude declined to assess this posting.');
      if (response.stop_reason === 'max_tokens') throw new Error('The assessment was cut off before it finished.');
      const text = response.content.find((block) => block.type === 'text');
      if (!text || text.type !== 'text') throw new Error('Assessment response did not contain structured text.');
      return {
        data: JSON.parse(text.text),
        inputTokens: response.usage.input_tokens ?? null,
        outputTokens: response.usage.output_tokens ?? null,
        // After a fallback, the serving model sets the price.
        model: response.model,
      };
    },
  };
}

import { ASSESSMENT_INSTRUCTIONS, type AssessmentProvider } from './drafting-assessment';

export function openaiProvider(apiKey: string, model: string): AssessmentProvider {
  return {
    provider: 'openai',
    model,
    assess: async (request) => {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, reasoning: { effort: 'low' }, store: false,
          input: [
            { role: 'system', content: ASSESSMENT_INSTRUCTIONS },
            { role: 'user', content: JSON.stringify(request) },
          ],
          text: { format: { type: 'json_object' } }, max_output_tokens: 2500,
        }),
      });
      if (!response.ok) throw new Error(`Assessment provider returned ${response.status}.`);
      const result = await response.json();
      const usage = result.usage ?? {};
      const outputText = (result.output ?? [])
        .flatMap((item: { content?: Array<{ type?: string; text?: string }> }) => item.content ?? [])
        .find((part: { type?: string }) => part.type === 'output_text')?.text;
      if (!outputText) throw new Error('Assessment response did not contain structured text.');
      return {
        data: JSON.parse(outputText),
        inputTokens: Number.isInteger(usage.input_tokens) ? usage.input_tokens : null,
        outputTokens: Number.isInteger(usage.output_tokens) ? usage.output_tokens : null,
        model,
      };
    },
  };
}

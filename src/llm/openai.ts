import OpenAI from 'openai';
import type { LLMAdapter, GroupForReview, Suggestion } from '../types.js';

export class OpenAIAdapter implements LLMAdapter {
  private client: OpenAI;
  private model = 'gpt-4o-mini'; // fast + cheap for bulk guessing

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async proposePayee(rawPayee: string, knownPayees: string[]): Promise<string> {
    const known = knownPayees.length > 0
      ? `Known payees (prefer reusing these if appropriate):\n${knownPayees.join(', ')}`
      : '';

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 64,
      messages: [{
        role: 'user',
        content: `Convert this raw bank transaction payee name to a clean, human-readable name.
Return ONLY the clean name, nothing else.

Raw payee: "${rawPayee}"
${known}`,
      }],
    });

    return response.choices[0].message.content?.trim() ?? rawPayee;
  }

  async proposeCategory(cleanPayee: string, categories: string[]): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 64,
      messages: [{
        role: 'user',
        content: `Which category best fits this payee? Return ONLY the category name, nothing else.

Payee: "${cleanPayee}"
Categories: ${categories.join(', ')}`,
      }],
    });

    return response.choices[0].message.content?.trim() ?? categories[0];
  }

  async reviewGroupings(groups: GroupForReview[]): Promise<Suggestion[]> {
    // Only groups with multiple raw payees can have a miscategorization — skip singletons
    const multiGroups = groups.filter(g => g.rawPayees.length > 1);
    if (multiGroups.length === 0) return [];

    const groupText = multiGroups
      .map(g => `- "${g.cleanPayee}" (${g.category ?? 'no category'}): ${g.rawPayees.join(' | ')}`)
      .join('\n');

    const response = await this.client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 4096,
      tools: [{
        type: 'function',
        function: {
          name: 'report_anomalies',
          description: 'Report anomalies and suggestions for payee groupings',
          parameters: {
            type: 'object',
            properties: {
              suggestions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    type: { type: 'string', enum: ['split', 'rename', 'category', 'flag'] },
                    cleanPayee: { type: 'string', description: 'Current clean payee name this applies to' },
                    rawPayees: { type: 'array', items: { type: 'string' }, description: 'split only: exact raw payee strings to split off (must match exactly)' },
                    suggestedName: { type: 'string', description: 'split/rename: new clean name' },
                    suggestedCategory: { type: 'string', description: 'split/category: new category name' },
                    reason: { type: 'string', description: 'One sentence explanation' },
                  },
                  required: ['type', 'cleanPayee', 'reason'],
                },
              },
            },
            required: ['suggestions'],
          },
        },
      }],
      tool_choice: { type: 'function', function: { name: 'report_anomalies' } },
      messages: [{
        role: 'user',
        content: `You are reviewing bank transaction payee groupings for a personal finance app. Each line shows: clean name (category): raw bank strings that map to it.

Actively look for and flag these patterns:

- SPLIT: raw payees in the same group that represent meaningfully different merchants or expense types (e.g. "AMAZON FRESH" mixed with "AMAZON MKTPL" — groceries vs shopping; or multiple distinct gas station brands like "CASEY'S", "KWIK TRIP", "SHELL" all collapsed under one name — each brand should be its own payee)
- RENAME: the clean name is a generic category word ("Gas Station", "Restaurant", "Store") instead of the actual merchant name, or is unclear/too abbreviated
- CATEGORY: the assigned category seems wrong for the merchant type
- FLAG: transfers between accounts disguised as expenses (e.g. "AUTOMATIC PAYMENT", "ONLINE PAYMENT"), or other notable issues

Key rule: different businesses should never share a clean name, even if they're in the same industry. "Shell" and "Casey's" and "Kwik Trip" are different payees that happen to sell gas — they should not be merged.

Be thorough. Flag every issue you find.

${groupText}`,
      }],
    });

    if (response.choices[0].finish_reason === 'length') {
      console.warn('⚠  AI review hit the token limit — results may be incomplete. Try running with fewer transactions.');
    }

    const toolCall = response.choices[0].message.tool_calls?.[0];
    if (!toolCall || toolCall.type !== 'function') return [];
    return (JSON.parse(toolCall.function.arguments).suggestions as Suggestion[]) ?? [];
  }
}

import Anthropic from '@anthropic-ai/sdk';
import type { LLMAdapter } from '../types.js';

export class AnthropicAdapter implements LLMAdapter {
  private client: Anthropic;
  private model = 'claude-haiku-4-5-20251001'; // fast + cheap for bulk guessing

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async proposePayee(rawPayee: string, knownPayees: string[]): Promise<string> {
    const known = knownPayees.length > 0
      ? `Known payees (prefer reusing these if appropriate):\n${knownPayees.join(', ')}`
      : '';

    const msg = await this.client.messages.create({
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

    return (msg.content[0] as { text: string }).text.trim();
  }

  async proposeCategory(cleanPayee: string, categories: string[]): Promise<string> {
    const msg = await this.client.messages.create({
      model: this.model,
      max_tokens: 64,
      messages: [{
        role: 'user',
        content: `Which category best fits this payee? Return ONLY the category name, nothing else.

Payee: "${cleanPayee}"
Categories: ${categories.join(', ')}`,
      }],
    });

    return (msg.content[0] as { text: string }).text.trim();
  }
}

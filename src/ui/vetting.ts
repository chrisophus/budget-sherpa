import { input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import type { RawTransaction, Rule, VettedRule, LLMAdapter } from '../types.js';
import { ruleKey, findPreRule, findCategoryRule } from '../rules/engine.js';
import { extractMatchValue } from '../rules/normalize.js';
import type { VettedRuleStore } from '../rules/vetted.js';

// --- Stage 1: Payee cleaning ---

export async function vetPayeeRule(
  rawPayee: string,
  sampleTxs: RawTransaction[],
  rules: Rule[],
  vetted: VettedRuleStore,
  llm: LLMAdapter,
  knownPayees: string[],
  payeeById: Map<string, string>,
): Promise<{ cleanPayee: string; rule: VettedRule } | null> {

  // Check vetted store first (handles restarts for locally-created rules)
  const vettedByPayee = vetted.findPayeeRule(rawPayee);
  if (vettedByPayee) {
    return { cleanPayee: vettedByPayee.actionValue, rule: vettedByPayee };
  }

  const matchedRule = findPreRule(rules, sampleTxs[0]);
  const key = matchedRule ? ruleKey(matchedRule) : null;

  // Already vetted via Actual Budget rule key
  if (key && vetted.isVetted(key)) {
    return { cleanPayee: vetted.get(key)!.actionValue, rule: vetted.get(key)! };
  }

  console.log('\n' + chalk.bold('── Payee Rule ──────────────────────────────'));
  console.log(chalk.dim('Raw payee:   ') + chalk.yellow(rawPayee));
  console.log(chalk.dim('Occurrences: ') + sampleTxs.length);

  // Resolve UUID → name if the matched rule stores a payee ID
  const rawValue = matchedRule?.actions.find(a => a.field === 'payee')?.value ?? rawPayee;
  const resolvedValue = payeeById.get(rawValue) ?? rawValue;

  // Propose a clean name
  let proposed = matchedRule
    ? resolvedValue
    : await llm.proposePayee(rawPayee, knownPayees);

  // Derive the stable match pattern (strip variable trailing codes)
  // Use the existing rule's condition value if available; otherwise heuristic-strip the raw payee
  let matchValue = matchedRule
    ? (matchedRule.conditions.find(c => c.field === 'imported_payee')?.value ?? rawPayee)
    : extractMatchValue(rawPayee);

  console.log(chalk.dim('Match pattern:') + ' ' + chalk.yellow(matchValue));
  console.log(chalk.dim('Proposed:    ') + chalk.cyan(proposed));
  if (matchedRule) console.log(chalk.dim('(from existing unvetted rule)'));

  while (true) {
    const action = await select({
      message: 'Accept?',
      choices: [
        { name: `Accept "${proposed}"`, value: 'accept' },
        { name: 'Edit name', value: 'edit-name' },
        { name: 'Edit match pattern', value: 'edit-match' },
        { name: 'Skip (no rule)', value: 'skip' },
      ],
    });

    if (action === 'skip') return null;

    if (action === 'edit-name') {
      proposed = await input({ message: 'Clean payee name:', default: proposed });
    }

    if (action === 'edit-match') {
      matchValue = await input({ message: 'Match pattern (contains):', default: matchValue });
    }

    if (action === 'accept' || action === 'edit-name' || action === 'edit-match') {
      const vettedRule: VettedRule = {
        key: key ?? `pre:imported_payee:contains:${matchValue}:payee:${proposed}`,
        stage: 'pre',
        matchField: 'imported_payee',
        matchOp: 'contains',
        matchValue,
        actionField: 'payee',
        actionValue: proposed,
        vettedAt: new Date().toISOString(),
      };
      vetted.approve(vettedRule);
      console.log(chalk.green(`✓ Approved: "${matchValue}" → "${proposed}"`));
      return { cleanPayee: proposed, rule: vettedRule };
    }
  }
}

// --- Stage 2: Category assignment ---

export async function vetCategoryRule(
  cleanPayee: string,
  rules: Rule[],
  vetted: VettedRuleStore,
  llm: LLMAdapter,
  categories: string[],
  categoryById: Map<string, string>,
): Promise<{ category: string; rule: VettedRule } | null> {

  // Check vetted store first (handles restarts for locally-created rules)
  const vettedByPayee = vetted.findCategoryRule(cleanPayee);
  if (vettedByPayee) {
    return { category: vettedByPayee.actionValue, rule: vettedByPayee };
  }

  const matchedRule = findCategoryRule(rules, cleanPayee);
  const key = matchedRule ? ruleKey(matchedRule) : null;

  // Already vetted via Actual Budget rule key
  if (key && vetted.isVetted(key)) {
    return { category: vetted.get(key)!.actionValue, rule: vetted.get(key)! };
  }

  console.log(chalk.bold('── Category Rule ───────────────────────────'));
  console.log(chalk.dim('Payee: ') + chalk.cyan(cleanPayee));

  // Resolve UUID → name if the matched rule stores a category ID
  const rawValue = matchedRule?.actions.find(a => a.field === 'category')?.value ?? '';
  const resolvedValue = categoryById.get(rawValue) ?? rawValue;

  let proposed = matchedRule
    ? resolvedValue
    : await llm.proposeCategory(cleanPayee, categories);

  console.log(chalk.dim('Proposed category: ') + chalk.magenta(proposed));

  while (true) {
    const action = await select({
      message: 'Accept this category?',
      choices: [
        { name: `Accept "${proposed}"`, value: 'accept' },
        { name: 'Choose from list', value: 'choose' },
        { name: 'Skip (no category)', value: 'skip' },
      ],
    });

    if (action === 'skip') return null;

    if (action === 'choose') {
      proposed = await select({
        message: 'Select category:',
        choices: categories.map(c => ({ name: c, value: c })),
      });
    }

    if (action === 'accept' || action === 'choose') {
      const vettedRule: VettedRule = {
        key: key ?? `null:payee:is:${cleanPayee}:category:${proposed}`,
        stage: null,
        matchField: 'payee',
        matchOp: 'is',
        matchValue: cleanPayee,
        actionField: 'category',
        actionValue: proposed,
        vettedAt: new Date().toISOString(),
      };
      vetted.approve(vettedRule);
      console.log(chalk.green(`✓ Approved: "${cleanPayee}" → "${proposed}"`));
      return { category: proposed, rule: vettedRule };
    }
  }
}

// --- Stage 3: Tag assignment ---

const TAG_CHOICES = [
  { name: 'Fixed          #fixed', value: 'fixed' },
  { name: 'Discretionary  #discretionary', value: 'discretionary' },
  { name: 'Subscription   #subscription', value: 'subscription' },
  { name: 'Skip (no tag)', value: '' },
] as const;

export async function vetTag(
  cleanPayee: string,
  vetted: VettedRuleStore,
): Promise<string | null> {
  // Already decided in a prior session
  if (vetted.hasTag(cleanPayee)) {
    return vetted.getTag(cleanPayee);
  }

  const tag = await select({
    message: `Tag "${cleanPayee}":`,
    choices: TAG_CHOICES as any,
  }) as string;

  const result = tag === '' ? null : tag;
  vetted.setTag(cleanPayee, result);
  if (result) console.log(chalk.green(`✓ Tagged: "${cleanPayee}" → #${result}`));
  return result;
}

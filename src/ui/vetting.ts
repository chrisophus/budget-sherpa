import { input, select, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import type { RawTransaction, Rule, VettedRule, LLMAdapter } from '../types.js';
import { ruleKey, findPreRule, findCategoryRule } from '../rules/engine.js';
import type { VettedRuleStore } from '../rules/vetted.js';

// --- Stage 1: Payee cleaning ---

export async function vetPayeeRule(
  rawPayee: string,
  sampleTxs: RawTransaction[],
  rules: Rule[],
  vetted: VettedRuleStore,
  llm: LLMAdapter,
  knownPayees: string[],
): Promise<{ cleanPayee: string; rule: VettedRule } | null> {

  const matchedRule = findPreRule(rules, sampleTxs[0]);
  const key = matchedRule ? ruleKey(matchedRule) : null;

  // Already vetted — silent pass
  if (key && vetted.isVetted(key)) {
    return { cleanPayee: vetted.get(key)!.actionValue, rule: vetted.get(key)! };
  }

  console.log('\n' + chalk.bold('── Payee Rule ──────────────────────────────'));
  console.log(chalk.dim('Raw payee:   ') + chalk.yellow(rawPayee));
  console.log(chalk.dim('Occurrences: ') + sampleTxs.length);

  // Propose a clean name
  let proposed = matchedRule
    ? matchedRule.actions.find(a => a.field === 'payee')?.value ?? rawPayee
    : await llm.proposePayee(rawPayee, knownPayees);

  console.log(chalk.dim('Proposed:    ') + chalk.cyan(proposed));
  if (matchedRule) console.log(chalk.dim('(from existing unvetted rule)'));

  while (true) {
    const action = await select({
      message: 'Accept this payee name?',
      choices: [
        { name: `Accept "${proposed}"`, value: 'accept' },
        { name: 'Edit', value: 'edit' },
        { name: 'Skip (no rule)', value: 'skip' },
      ],
    });

    if (action === 'skip') return null;

    if (action === 'edit') {
      proposed = await input({ message: 'Clean payee name:', default: proposed });
    }

    if (action === 'accept' || action === 'edit') {
      const vettedRule: VettedRule = {
        key: key ?? `pre:imported_payee:contains:${rawPayee}:payee:${proposed}`,
        stage: 'pre',
        matchField: 'imported_payee',
        matchOp: 'contains',
        matchValue: rawPayee,
        actionField: 'payee',
        actionValue: proposed,
        vettedAt: new Date().toISOString(),
      };
      vetted.approve(vettedRule);
      console.log(chalk.green(`✓ Approved: "${rawPayee}" → "${proposed}"`));
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
): Promise<{ category: string; rule: VettedRule } | null> {

  const matchedRule = findCategoryRule(rules, cleanPayee);
  const key = matchedRule ? ruleKey(matchedRule) : null;

  // Already vetted — silent pass
  if (key && vetted.isVetted(key)) {
    return { category: vetted.get(key)!.actionValue, rule: vetted.get(key)! };
  }

  console.log(chalk.bold('── Category Rule ───────────────────────────'));
  console.log(chalk.dim('Payee: ') + chalk.cyan(cleanPayee));

  let proposed = matchedRule
    ? matchedRule.actions.find(a => a.field === 'category')?.value ?? ''
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

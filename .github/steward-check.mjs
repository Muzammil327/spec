#!/usr/bin/env node
/**
 * Fails when an outside contribution has been left without a maintainer reply.
 *
 * Reads issues.json / prs.json (written by the steward workflow), then asks
 * the API for each item's comments. An item counts as "awaiting reply" when:
 *
 *   - it was opened by someone who is not a maintainer and not a bot, and
 *   - no maintainer has commented on it, and
 *   - it is older than GRACE_DAYS.
 *
 * The grace period matters. Failing the moment something is opened would turn
 * the alert into noise, and an alert that fires constantly is one you stop
 * reading -- the same reason the weekly growth email was switched off.
 *
 * Exit 1 makes GitHub email the repository owner. Nothing is posted publicly.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const repo = process.env.REPO;
const maintainers = (process.env.MAINTAINERS || '')
  .split(/[,\s]+/).filter(Boolean).map((s) => s.toLowerCase());
const graceDays = Number(process.env.GRACE_DAYS || '7');

const isBot = (login = '') =>
  login.endsWith('[bot]') || /(^|-)(bot|dependabot|renovate)$/i.test(login);
const isMaintainer = (login = '') => maintainers.includes(login.toLowerCase());

const read = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return []; } };

function commenters(kind, number) {
  // gh api paginates; --paginate returns a concatenated array via jq -s.
  try {
    const out = execFileSync('gh', [
      'api', '--paginate', `repos/${repo}/issues/${number}/comments`,
      '--jq', '.[].user.login',
    ], { encoding: 'utf8' });
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

const ageDays = (iso) => (Date.now() - new Date(iso).getTime()) / 86400000;

const waiting = [];
const items = [
  ...read('issues.json').map((i) => ({ ...i, kind: 'issue' })),
  ...read('prs.json').map((i) => ({ ...i, kind: 'pull request' })),
];

for (const it of items) {
  const author = it.author?.login || '';
  if (isMaintainer(author) || isBot(author)) continue;

  const age = ageDays(it.createdAt);
  if (age < graceDays) continue;

  const replied = commenters(it.kind, it.number).some(isMaintainer);
  if (!replied) waiting.push({ ...it, author, age: Math.floor(age) });
}

console.log(`Scanned ${items.length} open item(s); maintainers: ${maintainers.join(', ') || '(none set)'}`);

if (waiting.length === 0) {
  console.log('Nothing is waiting on a reply.');
  process.exit(0);
}

console.error(`\n${waiting.length} contribution(s) awaiting a maintainer reply:\n`);
for (const w of waiting.sort((a, b) => b.age - a.age)) {
  console.error(`  ${w.age}d  ${w.kind} #${w.number} by ${w.author}`);
  console.error(`       ${w.title}`);
  console.error(`       ${w.url}\n`);
}
console.error('These are the only part of this project that decays from neglect.');
process.exit(1);

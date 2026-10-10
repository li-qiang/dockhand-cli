/**
 * Command lookup.
 *
 * `dockhand` resolves the leading words of argv against the generated table:
 * the longest matching command wins, then verb aliases, then group aliases, and
 * finally a "did you mean" list built from the same table.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

let cached = null;
let aliasMapCache = null;

export function loadTable() {
  if (!cached) {
    cached = JSON.parse(readFileSync(resolve(HERE, 'commands.generated.json'), 'utf8'));
  }
  return cached;
}

export function resetTable() {
  cached = null;
  aliasMapCache = null;
}

export function commandsOf(table, group) {
  return table.commands.filter((c) => c.group === group);
}

function aliasMap(table) {
  if (!aliasMapCache) {
    aliasMapCache = new Map();
    for (const cmd of table.commands) {
      for (const alias of cmd.aliases ?? []) {
        if (!aliasMapCache.has(alias)) aliasMapCache.set(alias, cmd);
      }
    }
  }
  return aliasMapCache;
}

/**
 * Longest-prefix match of the leading argv words.
 * @returns {{command: object|null, rest: string[], matched: number}}
 */
export function resolveCommand(table, words) {
  const byName = new Map(table.commands.map((c) => [c.name, c]));
  const byAlias = aliasMap(table);
  const groupAliases = table.groupAliases ?? {};

  for (let n = Math.min(words.length, 6); n >= 1; n--) {
    const key = words.slice(0, n).join(' ');

    if (byName.has(key)) return { command: byName.get(key), rest: words.slice(n), matched: n };
    if (byAlias.has(key)) return { command: byAlias.get(key), rest: words.slice(n), matched: n };

    const groupAlias = groupAliases[words[0]];
    if (groupAlias) {
      const substituted = [groupAlias, ...words.slice(1, n)].join(' ');
      if (byName.has(substituted)) return { command: byName.get(substituted), rest: words.slice(n), matched: n };
      if (byAlias.has(substituted)) return { command: byAlias.get(substituted), rest: words.slice(n), matched: n };
    }
  }

  return { command: null, rest: words.slice(), matched: 0 };
}

/** Suggestions for an unrecognised first word. */
export function suggest(table, word, limit = 8) {
  const lower = word.toLowerCase();
  const scored = [];
  for (const group of table.groups) {
    let score = 0;
    if (group === lower) score = 100;
    else if (group.startsWith(lower)) score = 80 - group.length;
    else if (group.includes(lower)) score = 50 - group.length;
    else if (lower.startsWith(group)) score = 40 - group.length;
    else score = -Math.abs(group.length - lower.length);
    if (score > 0) scored.push({ text: group, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.text);
}
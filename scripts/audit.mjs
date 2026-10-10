#!/usr/bin/env node
/**
 * Publishing gate: scan everything that would ship in the npm tarball for
 * secrets, personal data and machine-specific values.
 *
 * Run manually with `npm run audit`; it is also part of `npm run verify`, which
 * `prepublishOnly` runs before every publish — so a tarball with a leaked token
 * or a colleague's email address cannot be published by accident.
 *
 * Rules:
 *   - only files reachable through package.json `files` are scanned (plus the
 *     manifest itself), so the check matches exactly what npm would upload;
 *   - findings are grouped by rule and printed with file:line;
 *   - exit code 1 means the release is blocked.
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const TEXT = /\.(js|mjs|cjs|ts|json|md|txt|yml|yaml|sh|gitignore|npmignore)$/;
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Each rule explains itself: `allow` marks values that are documentation
 * placeholders rather than real data.
 */
const RULES = [
  {
    id: 'private-key',
    pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
    why: 'private key material',
  },
  {
    id: 'github-token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/,
    why: 'GitHub token',
  },
  {
    id: 'npm-token',
    pattern: /\bnpm_[A-Za-z0-9]{30,}/,
    why: 'npm token',
  },
  {
    id: 'dockhand-token',
    pattern: /\bdh_[A-Za-z0-9]{20,}/,
    why: 'Dockhand API token',
    // The spec documents the token format with a literal xxxx placeholder.
    allow: (line, match) => /^dh_x+$/.test(match),
  },
  {
    id: 'aws-key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    why: 'AWS access key id',
  },
  {
    id: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    why: 'JWT token',
  },
  {
    id: 'slack-token',
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
    why: 'Slack token',
  },
  {
    id: 'basic-auth-url',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
    why: 'credentials embedded in a URL',
  },
  {
    id: 'personal-email',
    // Documentation placeholders (@example.com / @example.org) are fine.
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
    why: 'email address — publishing one exposes a personal inbox',
    allow: (line, match) => /@(example\.(com|org|net)|test|localhost|invalid)$/i.test(match),
  },
  {
    id: 'private-ip',
    pattern: /\b(?:10|127|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){3}\b/,
    why: 'private network address — identifies an internal network',
    allow: (line) => /127\.0\.0\.1/.test(line),
  },
  {
    id: 'home-path',
    pattern: /\/(?:Users|home)\/[A-Za-z0-9._-]+/,
    why: 'absolute home directory path — leaks the developer account name',
    // `/home/dockhand` is the product's own runtime path inside its container
    // image, documented in the spec — not somebody's home directory.
    allow: (line, match) => match.toLowerCase() === '/home/dockhand',
  },
  {
    id: 'internal-host',
    pattern: /\b[a-z0-9-]+\.(?:ghe\.com|internal|intranet|corp|local)\b/i,
    why: 'internal or enterprise host name',
  },
];

/** Expand package.json `files` globs (only the simple, documented forms). */
function collectShippedFiles() {
  const out = new Set(['package.json']);
  const visit = (rel) => {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) {
      for (const entry of readdirSync(abs)) {
        if (entry === 'node_modules' || entry.startsWith('.git')) continue;
        visit(join(rel, entry));
      }
      return;
    }
    out.add(rel);
  };
  for (const entry of manifest.files ?? []) visit(entry);
  return [...out];
}

const findings = [];
for (const rel of collectShippedFiles()) {
  const abs = join(ROOT, rel);
  if (!TEXT.test(rel)) continue;
  if (statSync(abs).size > MAX_BYTES) continue;

  const lines = readFileSync(abs, 'utf8').split('\n');
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      const match = line.match(rule.pattern);
      if (!match) continue;
      if (rule.allow?.(line, match[0])) continue;
      findings.push({
        rule: rule.id,
        why: rule.why,
        file: rel,
        line: index + 1,
        excerpt: `${match[0].slice(0, 12)}…${match[0].length > 12 ? '' : ''}`.padEnd(14),
      });
    }
  });
}

const scanned = collectShippedFiles().filter((f) => TEXT.test(f)).length;

if (findings.length === 0) {
  console.log(`audit ok: ${scanned} shipped files clean (${RULES.length} rules, ${manifest.name}@${manifest.version})`);
  process.exit(0);
}

console.error(`audit FAILED: ${findings.length} finding(s) in ${manifest.name}@${manifest.version}\n`);
const byRule = new Map();
for (const finding of findings) {
  if (!byRule.has(finding.rule)) byRule.set(finding.rule, []);
  byRule.get(finding.rule).push(finding);
}
for (const [rule, group] of byRule) {
  console.error(`  ${rule} — ${group[0].why} (${group.length})`);
  for (const hit of group) {
    console.error(`      ${hit.file}:${hit.line}  ${hit.excerpt}`);
  }
}
console.error('\n  Fix or remove these before publishing, or allowlist them explicitly.');
process.exit(1);
/**
 * Argument parsing.
 *
 * The parser is deliberately forgiving: it never throws on an unknown flag,
 * because a command may need to forward an arbitrary key (see `raw`). Callers
 * decide which leftovers are acceptable.
 */

export const BOOLEAN_GLOBAL_FLAGS = new Set([
  'help', 'h', 'version', 'v', 'verbose', 'quiet', 'no-color', 'pretty',
  'dry-run', 'public', 'stdin', 'confirm',
]);

/** Single-dash shorthands that map onto a long flag. */
export const SHORT_FLAGS = {
  e: 'env',
  o: 'output',
  h: 'help',
  v: 'version',
  q: 'quiet',
  E: 'env',
};

/**
 * @param {string[]} tokens raw argv (already stripped of the command name)
 * @param {{booleans?: Set<string>}} options flags that may appear without a value
 */
export function parseArgs(tokens, options = {}) {
  const booleans = options.booleans ?? BOOLEAN_GLOBAL_FLAGS;
  const positionals = [];
  const flags = new Map();
  const rest = [];
  let sawDoubleDash = false;

  const setFlag = (name, value) => {
    if (!flags.has(name)) flags.set(name, []);
    flags.get(name).push(value);
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (sawDoubleDash) {
      rest.push(token);
      continue;
    }
    if (token === '--') {
      sawDoubleDash = true;
      continue;
    }

    if (token.startsWith('--')) {
      let name = token.slice(2);
      let value;
      const eq = name.indexOf('=');
      if (eq !== -1) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
      }

      if (value === undefined) {
        if (name.startsWith('no-') && booleans.has(name.slice(3))) {
          setFlag(name, false);
          continue;
        }
        if (booleans.has(name)) {
          const next = tokens[i + 1];
          // `--all` and `--all false` are both valid for boolean fields.
          if (next === 'true' || next === 'false') {
            setFlag(name, next === 'true');
            i++;
          } else {
            setFlag(name, true);
          }
          continue;
        }
        const next = tokens[i + 1];
        if (next === undefined || (next.startsWith('-') && next !== '-' && !/^-\d/.test(next))) {
          // A value-taking flag with nothing after it.
          setFlag(name, '');
          continue;
        }
        value = next;
        i++;
      }
      setFlag(name, coerceFlagValue(name, value));
      continue;
    }

    if (token.startsWith('-') && token.length > 1 && !/^-\d/.test(token)) {
      const short = token.slice(1);
      const name = SHORT_FLAGS[short] ?? short;
      const next = tokens[i + 1];
      if (booleans.has(name)) {
        if (next === 'true' || next === 'false') {
          setFlag(name, next === 'true');
          i++;
        } else {
          setFlag(name, true);
        }
        continue;
      }
      if (next !== undefined && !(next.startsWith('-') && next !== '-' && !/^-\d/.test(next))) {
        setFlag(name, coerceFlagValue(name, next));
        i++;
      } else {
        setFlag(name, '');
      }
      continue;
    }

    positionals.push(token);
  }

  return { positionals, flags, rest };
}

function coerceFlagValue(name, value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

/** Last value wins, which is what a bare override is expected to do. */
export function flagValue(flags, name, fallback = undefined) {
  if (!flags.has(name)) return fallback;
  const values = flags.get(name);
  return values[values.length - 1];
}

export function flagValues(flags, name) {
  return flags.get(name) ?? [];
}

export function hasFlag(flags, name) {
  return flags.has(name);
}
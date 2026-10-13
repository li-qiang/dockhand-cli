/**
 * HTTP layer. Everything the CLI sends goes through `Client.request`, which
 * owns auth headers, timeouts, and the translation of HTTP failures into
 * errors with meaningful exit codes.
 */

export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  AUTH: 3,
  NOT_FOUND: 4,
  CONFLICT: 5,
  RATE_LIMIT: 6,
  NETWORK: 7,
};

export class CliError extends Error {
  constructor(message, { exitCode = EXIT.ERROR, details, cause } = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function exitCodeForStatus(status) {
  if (status === 401 || status === 403) return EXIT.AUTH;
  if (status === 404) return EXIT.NOT_FOUND;
  if (status === 409) return EXIT.CONFLICT;
  if (status === 429) return EXIT.RATE_LIMIT;
  if (status === 400 || status === 422) return EXIT.USAGE;
  return EXIT.ERROR;
}

const STATUS_TEXT = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

export class Client {
  constructor(settings, { userAgent = '@qlee/dockhand-cli' } = {}) {
    this.settings = settings;
    this.userAgent = userAgent;
  }

  buildUrl(path, query) {
    const url = new URL(path.startsWith('/') ? path : `/${path}`, `${this.settings.baseUrl}/`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.append(key, String(value));
      }
    }
    return url;
  }

  headers({ contentType, extra, accept } = {}) {
    const headers = {
      accept: accept ?? 'application/json',
      'user-agent': this.userAgent,
    };
    if (contentType) headers['content-type'] = contentType;
    if (this.settings.token) headers.authorization = `Bearer ${this.settings.token}`;
    if (this.settings.cookie) headers.cookie = this.settings.cookie.includes('=')
      ? this.settings.cookie
      : `dockhand_session=${this.settings.cookie}`;
    return { ...headers, ...(extra ?? {}) };
  }

  async request({
    method,
    path,
    query,
    body,
    headers,
    accept,
    stream = false,
    rawBody,
    timeout,
  }) {
    const url = this.buildUrl(path, query);
    const budget = timeout ?? this.settings.timeout;
    const init = {
      method,
      headers: this.headers({ contentType: body !== undefined ? 'application/json' : undefined, extra: headers, accept }),
      // `--timeout 0` disables the deadline, which is what large downloads need.
      signal: budget > 0 ? AbortSignal.timeout(budget) : undefined,
    };
    if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (rawBody !== undefined) init.body = rawBody;

    if (this.settings.verbose) {
      process.stderr.write(`> ${method} ${url}\n`);
      if (init.body && typeof init.body === 'string') {
        process.stderr.write(`> body ${truncate(init.body, 2000)}\n`);
      }
    }

    const failure = (error) => {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      const reason = timedOut ? `timed out after ${budget / 1000}s` : (error?.message ?? String(error));
      return new CliError(`request to ${url.origin}${url.pathname} failed: ${reason}`, {
        exitCode: EXIT.NETWORK,
        cause: error,
      });
    };

    let response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      const problem = failure(error);
      if (!this.settings.baseUrlConfigured && error?.name !== 'TimeoutError') {
        problem.message += '\n  no Dockhand web URL configured — set one with:\n'
          + '    dockhand config set base-url https://dockhand.example.com\n'
          + '    export DOCKHAND_URL=https://dockhand.example.com';
      }
      throw problem;
    }

    if (this.settings.verbose) {
      process.stderr.write(`< ${response.status} ${response.statusText}\n`);
    }

    const contentType = response.headers.get('content-type') ?? '';

    if (!response.ok) {
      let text = '';
      try {
        text = await response.text();
      } catch {
        // The error body is unreadable; the status alone still has to surface.
      }
      throw new CliError(formatHttpError(response, text), {
        exitCode: exitCodeForStatus(response.status),
        details: safeParse(text),
      });
    }

    // Server-Sent Events: the response never ends on its own, so pipe it.
    if (contentType.includes('text/event-stream')) {
      return { status: response.status, headers: response.headers, contentType, eventStream: true, response, url };
    }

    const isTextual = /^(text\/|application\/(json|xml|javascript|x-ndjson|graphql))/i.test(contentType);
    try {
      if (!isTextual) {
        const buffer = Buffer.from(await response.arrayBuffer());
        return { status: response.status, headers: response.headers, contentType, binary: buffer };
      }
      return this.#decorate(await response.text(), response, contentType);
    } catch (error) {
      throw failure(error);
    }
  }

  #decorate(text, response, contentType) {
    const result = {
      status: response.status,
      headers: response.headers,
      contentType,
      text,
      data: contentType.includes('json') ? safeParse(text) : undefined,
    };
    if (this.settings.verbose && truncate(text, 400)) {
      process.stderr.write(`< body ${truncate(text, 2000)}\n`);
    }
    return result;
  }

  /** Pipe a Server-Sent Events response straight to stdout. */
  async streamSse(response) {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload) {
            process.stdout.write(`${payload}\n`);
          }
        } else if (line.startsWith('event:')) {
          process.stderr.write(`event: ${line.slice(6).trim()}\n`);
        }
      }
    }
    if (buffer.startsWith('data:')) process.stdout.write(`${buffer.slice(5).trim()}\n`);
  }

  /** Extract Set-Cookie values from a `Headers` instance, as returned by request(). */
  setCookieHeader(headers) {
    if (typeof headers?.getSetCookie === 'function') {
      const cookies = headers.getSetCookie();
      if (cookies.length) return cookies;
    }
    const single = headers?.get?.('set-cookie');
    return single ? [single] : [];
  }
}

function formatHttpError(response, text) {
  const status = `${response.status} ${STATUS_TEXT[response.status] ?? response.statusText ?? ''}`.trim();
  const url = response.url ? ` (${response.url})` : '';
  const contentType = response.headers?.get?.('content-type') ?? '';

  // A framework fallback page is noise, not a message worth echoing back.
  if (contentType.includes('text/html') && !text.includes('application/json')) {
    return `${status}${url}: the server returned an HTML page (${text.length} bytes) — check the path`;
  }

  const parsed = safeParse(text);
  const detail = extractMessage(parsed) ?? (text ? truncate(text, 300) : '');
  return detail ? `${status}${url}: ${detail}` : `${status}${url}`;
}

function extractMessage(parsed) {
  if (!parsed) return null;
  if (typeof parsed === 'string') return parsed;
  if (typeof parsed.error === 'string') return parsed.error;
  if (typeof parsed.message === 'string') return parsed.message;
  if (parsed.error && typeof parsed.error === 'object' && typeof parsed.error.message === 'string') {
    return parsed.error.message;
  }
  if (Array.isArray(parsed.errors) && parsed.errors.length) {
    return parsed.errors.map((e) => (typeof e === 'string' ? e : e.message ?? JSON.stringify(e))).join('; ');
  }
  return null;
}

export function safeParse(text) {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function truncate(text, max) {
  if (!text) return '';
  const flat = text.replace(/\n/g, ' ');
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
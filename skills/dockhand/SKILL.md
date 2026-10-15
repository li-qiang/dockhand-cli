---
name: dockhand
description: Operate a Dockhand server from the command line — containers, images, volumes, networks, compose stacks, Docker/Hawser environments, backups, schedules, registries, users and settings. Use when the user asks to manage or inspect Dockhand, deploy or troubleshoot Docker workloads through Dockhand, or automate a Dockhand instance over its REST API.
---

# Dockhand CLI

`dockhand` is a dependency-free Node.js client for the Dockhand REST API. Every
command is generated from the instance's OpenAPI document, so the command tree
always matches the server version it was generated from.

## 1. Point the CLI at an instance

There is no built-in host. Configure one once:

```bash
dockhand config set base-url https://dockhand.example.com
# or per-shell:
export DOCKHAND_URL=https://dockhand.example.com
# or per-call:
dockhand --base-url https://dockhand.example.com environments list
```

Precedence: flag > selected instance > `DOCKHAND_URL` > config file > `http://localhost:3000` (local dev only).

### Multiple Dockhand servers

Each server can be pre-configured as a named instance with its own URL and
credentials, so switching needs no flags per call:

```bash
dockhand config instance set prod base-url https://prod.example.com
dockhand config instance set prod token dh_...        # credentials stored once
dockhand config instance list                          # all instances, secrets redacted
dockhand containers list                               # default instance
dockhand -i prod containers list                       # --instance prod applies its token
dockhand --base-url https://prod.example.com stacks ls # a configured URL also pulls its token
export DOCKHAND_INSTANCE=prod                          # or switch per shell
```

## 2. Authenticate

Authentication is only required when the instance has auth enabled. **Prefer an
API token** — it is long-lived, while the username/password session cookie can
expire mid-session.

```bash
dockhand login --token dh_...        # validates and stores the token (recommended)
dockhand login --token - < token.txt # read the token from stdin (keeps it out of history)
dockhand login --username admin --password "$PASSWORD"   # session cookie (can expire)
dockhand login --username admin --password "$PASSWORD" --save-token ci
dockhand login --instance prod --token dh_...            # into that instance
export DOCKHAND_TOKEN=dh_...                             # preferred in CI
```

`login --token` verifies the token via `GET /api/auth/tokens` before storing
it, and also records the base URL it was used with. Create tokens in the
Dockhand web UI; leaving the expiry empty makes them non-expiring. Credentials
live in `~/.config/dockhand/config.json` (mode 0600); instance credentials live
in the `instances` section of the same file. `dockhand logout` clears the
default credentials, or the named instance with `--instance prod`.

## 3. Command model

```
dockhand <group> [<action>…] [<positional>…] [--flags]
```

- `group` is the first path segment: `/api/containers` → `containers`.
- Static path segments become actions: `/api/git/repositories/{id}/sync` → `git repositories sync <id>`.
- Path placeholders become positional arguments, in order.
- Query parameters and body fields become kebab-case flags: `destinationId` → `--destination-id`.
- A verb (`list`/`create`/`get`/`update`/`delete`) is only added when needed to disambiguate.

Discover before you act:

```bash
dockhand --help                 # every group
dockhand help containers        # commands in a group
dockhand containers create --help   # arguments, flags, body fields, response codes
dockhand spec commands          # the whole command table as JSON
```

## 4. Everyday recipes

```bash
# Which environments exist, then work against one with -e/--env
dockhand environments list -o table --fields id,name,host

# Containers
dockhand containers list -e 4 -o table --fields name,image,state,status
dockhand containers get <id> -e 4
dockhand containers start|stop|restart|pause|unpause <id> -e 4
dockhand containers logs get <id> -e 4 --tail 200
dockhand containers stats get <id> -e 4
dockhand containers update <id> -e 4 --restart-policy unless-stopped

# Create a container from flags or from a full JSON body
dockhand containers create -e 4 --name web --image nginx:alpine --restart-policy always
dockhand containers create -e 4 --data-file container.json

# Images, volumes, networks
dockhand images list -e 4
dockhand images pull -e 4 --image nginx:alpine
dockhand images delete <id> -e 4 --force
dockhand volumes list -e 4
dockhand networks list -e 4

# Compose stacks
dockhand stacks list -e 4
dockhand stacks deploy <name> -e 4
dockhand stacks env get <name> -e 4
dockhand stacks down <name> -e 4

# Health and dashboard
dockhand health get
dockhand dashboard stats get -e 4
```

## 5. Output and exit codes

`--output json` (default) | `ndjson` | `table` | `raw` | `auto`, plus `--fields a,b`
to trim table columns and `--out-file <path>` for binary downloads.

| code | meaning |
|---|---|
| 0 | success |
| 1 | generic failure (HTTP 5xx) |
| 2 | usage error (unknown flag, missing argument, missing required body, bad type) |
| 3 | auth/permission (401, 403) |
| 4 | not found (404) |
| 5 | conflict (409) |
| 6 | rate limited (429) |
| 7 | network or timeout |

Parse JSON with `jq`; branch on the exit code rather than on message text.

Connect-phase network failures (ECONNREFUSED, EHOSTUNREACH, …) are retried up to
3 times automatically before exit 7; the error message ends with the underlying
errno in parentheses, e.g. `fetch failed (EHOSTUNREACH)`.

## 6. Safety rules for agents

- **Dry-run every write first.** `dockhand containers delete web -e 4 --dry-run`
  prints the exact request without sending it.
- **Prefer reads before destructive calls.** List, inspect, then act.
- **Never echo secrets.** `--verbose` redacts the token; `dockhand config show`
  masks stored credentials.
- **Destructive flags exist**: `--force` on deletes/prunes. Do not add them
  unless the user explicitly asked for a forced operation.
- **Long-running work streams SSE.** `dockhand events -e 4`,
  `dockhand containers logs stream <id> -e 4`, `dockhand stacks deploy <name> -e 4`
  pipe events line by line; cap them with `timeout` or a head limit.

## 7. Types and bodies

Values are coerced from the schema, so bad input fails before the request:

- `--flag` / `--flag false` for booleans, `--no-flag` also works;
- arrays: `--cmd sh -c 'sleep 1'` or `--cmd sh,-c`;
- objects: `--ports '{"80/tcp":[{"host":"8080","container":"80"}]}'`;
- whole bodies: `--data '<json>'`, `--data-file <path>`, `--stdin`, or `-- '<json>'`.

Uploads use `--file <path>` (repeatable; `--file name=<path>` names the part) and
`--form k=v` for multipart endpoints such as `containers files upload`.

## 8. Escape hatch

For routes that are missing from the generated tree (new server endpoints, private APIs):

```bash
dockhand raw GET /api/containers --query env=4
dockhand raw POST /api/some/route --data '{"a":1}'
cat payload.json | dockhand raw PUT /api/some/route --stdin
```

## 9. When something fails

| symptom | fix |
|---|---|
| `unknown command` / `unknown action` | run `dockhand help <group>`; the endpoint may be new — refresh with `npx @qlee/dockhand-cli generate --fetch https://<host>/openapi.json` |
| exit 2 | the message lists the valid flags or missing arguments |
| exit 3 | run `dockhand login --token dh_...` (or set `DOCKHAND_TOKEN`) |
| exit 7 and no URL configured | `dockhand config set base-url https://<host>` |
| empty list | the endpoint usually needs an environment id: add `-e <id>` |

Re-generate the command table against your own instance when the server upgrades:

```bash
npx @qlee/dockhand-cli generate --fetch https://dockhand.example.com/openapi.json
```
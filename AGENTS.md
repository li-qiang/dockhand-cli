# AGENTS.md

本目录是 **Dockhand API 的命令行客户端**，以 npm 包 `@qlee/dockhand-cli` 发布（可执行文件名
`dockhand`）。所有命令都由 `api/openapi.json`（某实例的 `/openapi.json` 快照）自动生成，
运行时零第三方依赖，只用 Node.js 内置模块。

**包里不允许出现任何具体实例地址**：`--base-url` / `DOCKHAND_URL` / 配置文件都没配时，
才回落到 `http://localhost:3000`（本机开发用）。`test/cli.test.mjs` 里有一条测试会扫描
全部 `.js/.mjs/.json/.md`，一旦有人把某台机器的 IP 写回代码或文档就会失败。

> 面向使用者的速查请看 [README.md](README.md)；本文是给 **在本仓库里改代码的 agent** 看的。

---

## 1. 快速上手

```bash
dockhand --help                   # 全局安装后
node bin/dockhand.js version      # 源码目录里直接跑
dockhand help containers
dockhand containers create --help
dockhand containers list -e 4 --output table --fields name,state
dockhand containers restart web -e 4 --dry-run

dockhand config set base-url https://dockhand.example.com   # 首次配置
```

---

## 2. 目录结构

```
.
├── AGENTS.md                     # 本文件
├── README.md                     # 使用者速查
├── api/openapi.json              # OpenAPI 快照（唯一事实来源，勿手改）
├── bin/dockhand.js               # 可执行入口，只调用 src/cli.js 的 main()
├── scripts/generate.mjs          # 生成器：openapi.json -> src/commands.generated.json
├── skills/dockhand/SKILL.md      # 随包发布的 agent skill（`dockhand skill` 会打印它）
├── LICENSE                       # MIT
├── src/
│   ├── commands.generated.json  # 生成产物：命令表（366 条命令 + 18 条内置命令）
│   ├── cli.js                    # 解析 argv、构造请求、渲染输出、错误码
│   ├── commands.js               # 命令名/别名解析（最长前缀匹配）
│   ├── builtins.js               # login/logout/config/completion/spec/raw/help/version
│   ├── args.js                   # flag 解析器（--x=y、--no-x、可重复、`--`）
│   ├── client.js                 # HTTP 层：认证、超时、SSE、二进制、退出码
│   ├── config.js                 # flag > 命名实例 > env > 配置文件 > 默认值 的解析顺序
│   ├── help.js                   # 三级帮助（根 / 组 / 单命令）
│   ├── render.js                 # json / ndjson / table / raw / auto
│   └── completion.js             # bash / zsh / fish 补全脚本生成
└── test/cli.test.mjs             # node --test，覆盖参数、路由选择、请求构造、渲染
```

---

## 3. 命令模型

命令形态固定为：

```
dockhand <group> [<action>…] [<positional>…] [--flags]
```

| 部分 | 来源 | 说明 |
|---|---|---|
| `group` | 去掉 `/api` 后的第一段路径 | 例：`/api/git/repositories` → `git` |
| `action` | 其余**静态**路径段，原样保留 | 例：`/api/git/repositories/{id}/sync` → `git repositories sync` |
| positional | 路径里的 `{xxx}`，按出现顺序 | 例：`git repositories sync <id>` |
| flags | query 参数 + body 字段 | camelCase 自动转 kebab-case：`destinationId` → `--destination-id` |

### 3.1 动词（method token）何时出现

只有当不加动词会产生歧义时才追加，取值为 `list / create / get / update / delete`：

- 同一节点上有多个 HTTP 方法（`containers` 有 GET/POST/PUT/DELETE → `containers list|create|get|update|delete`）；
- 同一节点上有多条形状不同的路由（`auth settings get` / `auth settings update`）；
- 该节点下面还有子资源（`schedules get`、`schedules executions get`）。

只有一种方法、且下面没有子资源时不加动词：`containers start <id>`、`backup destinations test [<id>]`。

- `get` 与 `list` 的区分：返回数组、或同节点还存在带参数的 GET（即“集合 + 单条”成对出现）时用 `list`，
  否则用 `get`。两者互为别名，`audit list` 和 `audit get` 都能用。
- 名字撞车时用 `by-<参数>` 消歧（当前 API 未触发，生成器仍保留该逻辑并有断言保护）。

### 3.2 变体合并（可选参数）

只差尾部路径参数的路由会合并成一条命令，尾部参数可选，按实参个数选路由：

```
dockhand environments notifications 3        →  GET /api/environments/3/notifications
dockhand environments notifications 3 7      →  GET /api/environments/3/notifications/7
dockhand stacks deploys immich               →  GET /api/stacks/immich/deploys
dockhand stacks deploys immich 42            →  GET /api/stacks/immich/deploys/42
```

### 3.3 别名

- 动词别名：`ls → list`、`rm/del/remove → delete`、`new/add → create`、`show/describe/inspect/info → get`、`edit/set → update`。
- 分组别名在 `scripts/generate.mjs` 的 `GROUP_ALIASES` 里定义（`ctr`、`img`、`env`、`net`、`vol`、`stack`、`reg`、`sched`、`notif`、`secret`…）。
- 别名在 `src/commands.js` 里通过「最长前缀 + 别名表」解析，`dockhand ctr ls` == `dockhand containers list`。

---

## 4. Flag 规则

### 4.1 参数来源与优先级

`flag > 命名实例 > 环境变量 > 配置文件顶层 > 默认值`
（配置文件在 `~/.config/dockhand/config.json`；命名实例见 §5）

| 环境变量 | 作用 |
|---|---|
| `DOCKHAND_URL` | base URL |
| `DOCKHAND_TOKEN` | API token（`Authorization: Bearer …`） |
| `DOCKHAND_INSTANCE` | 选用命名实例（等价 `--instance`） |
| `DOCKHAND_CONFIG` | 配置文件路径 |
| `DOCKHAND_OUTPUT` | 默认输出格式 |
| `DOCKHAND_TIMEOUT` | 超时毫秒 |
| `NO_COLOR` | 关闭颜色 |

### 4.2 类型转换

按 OpenAPI 声明自动转换，转换失败直接报错（exit 2），不会发出错误请求：

- `boolean`：裸 `--all` = true，`--all false` = false，`--no-xxx` = false；
- `integer` / `number`：非数字直接报错；
- `array`：可重复（`--cmd sh --cmd -c`）且支持逗号分隔（`--cmd sh,-c`）；
- `object`：`--ports '{"80/tcp":[]}'`，内部做 `JSON.parse`。

### 4.3 命名冲突

**全局 flag 永远优先**。API 字段若与全局 flag 或 query 参数重名，生成器会自动加前缀，
所以 `containers create` 里同时存在 query 的 `--env` 和 body 的 `env` 数组时，body 那个变成 `--body-env`。
冲突清单见生成器顶部的 `GLOBAL_FLAGS`。

### 4.4 请求体

按以下顺序叠加（后者覆盖前者）：

1. `--data '{"json":"…"}'` / `--data-file <path>` / `--data-file -` / `--stdin` / `-- '{...}'`；
2. 单字段 flag：`--name web --image nginx`。

必填字段缺失时，一次性列出所有缺失项并提示改用 `--data`。

### 4.5 上传

| Content-Type | 用法 |
|---|---|
| `multipart/form-data`（`containers files upload`） | `--file <path>` 可重复；`--file name=<path>` 指定字段名；`--form k=v` 加普通字段 |
| `application/x-tar`（`images load`） | `--file <path>` |

### 4.6 SSE

响应 `content-type: text/event-stream` 时自动切换为流式：`data:` 行打到 stdout，`event:` 行打到 stderr。
判定依据是响应头，不是路径，所以 `batch` 这种 “Accept 协商” 的接口不会误判。

---

## 5. 认证

```bash
dockhand login --username admin --password "$PASS"            # 存 session cookie
dockhand login --username admin --password "$PASS" --save-token ci   # 顺便签发 API token
dockhand config set token dh_xxx
dockhand logout
```

- 服务端 `Set-Cookie: dockhand_session=…` 会被存进配置文件（0600 权限）。
- 也可以只用环境变量 `DOCKHAND_TOKEN`，适合 CI。
- 写操作前建议先 `dockhand <cmd> --dry-run` 确认将要发出的请求。
- 401/403 退出码为 3，429 为 6，详见 `src/client.js` 的 `EXIT`。

### 5.1 多实例（多个 Dockhand 服务）

配置文件里的 `instances` 段为每台服务保存独立的 URL 和凭据：

```json
{ "baseUrl": "https://default.example.com", "token": "dh_default",
  "instances": { "prod": { "baseUrl": "https://prod.example.com", "token": "dh_prod" } } }
```

```bash
dockhand config instance set prod base-url https://prod.example.com
dockhand config instance set prod token dh_xxx
dockhand config instance list                  # 清单（密钥打码）
dockhand config instance show prod / ... remove prod
dockhand -i prod containers list               # --instance / DOCKHAND_INSTANCE 选用
dockhand --base-url https://prod.example.com containers list   # URL 命中实例 → 自动套用其凭据
dockhand login --instance prod --username admin --password "$PASS"   # 凭据直接存入该实例
dockhand logout --instance prod                # 只清该实例
```

实现要点（`src/config.js`）：解析时先选出实例（`--instance`/`DOCKHAND_INSTANCE`），
未命名时按最终 baseUrl 归一化匹配实例条目；凭据链为
`flag > 实例条目 > 环境变量 > 配置文件顶层`。未知实例名不抛错，记入
`settings.instanceUnknown`，由 `src/cli.js` 统一拦截（`login` 例外，视为要创建的新实例）。

---

## 6. 输出与退出码

| `--output` | 行为 |
|---|---|
| `json`（默认） | 缩进 JSON |
| `ndjson` | 单行 JSON |
| `table` | 数组→对齐表格，对象→键值；配 `--fields a,b` 只显示部分列 |
| `raw` | 原始响应体 |
| `auto` | 自动判断表格/键值/JSON |

| 退出码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 一般错误（HTTP 5xx 等） |
| 2 | 用法错误（未知 flag、缺参数、缺必填 body、类型不匹配） |
| 3 | 认证/权限（401、403） |
| 4 | 未找到（404） |
| 5 | 冲突（409） |
| 6 | 限流（429） |
| 7 | 网络/超时 |

二进制响应（tar、图标）需要 `--out-file <path>` 或重定向 stdout。
大文件下载用 `--timeout 0` 关闭超时（例如 200MB+ 的 `images export`）。
调试服务端返回体：`DOCKHAND_DEBUG=1 dockhand <cmd>`。

---

## 7. 重新生成

```bash
npm run generate                          # 从本地 api/openapi.json 重新生成（离线、可复现）
node scripts/generate.mjs --fetch         # 从 DOCKHAND_URL 指向的实例拉取后生成
node scripts/generate.mjs --fetch https://dockhand.example.com/openapi.json
node scripts/generate.mjs --check         # 产物是否与 api/openapi.json 一致（verify 用）
node scripts/generate.mjs --stats         # 只看统计
npm run verify                            # --check + 测试（publish 前自动跑）
dockhand generate --fetch <url>           # 已安装的包里也能重新生成
```

**硬性规则：**

1. `src/commands.generated.json` 是产物，**永远不要手改**，改 `scripts/generate.mjs` 后重新生成；
2. `api/openapi.json` 是唯一事实来源（`--fetch` 会覆盖它），**永远不要手改**；
3. 生成器在命令名冲突时会直接失败并打印冲突的 HTTP 路径，不会静默丢命令；
4. 生成器只依赖 Node 内置模块，离线可跑；
5. 改了 `api/openapi.json` 或生成器后必须跑 `npm run generate`，否则 `npm run verify`（=发布前钩子）会失败；
6. 新增内置命令要同时加到 `scripts/generate.mjs` 的 `builtinCommands` 和 `src/builtins.js` 的 `switch`。

改命名规则（动词、分组别名、参数缩写）的入口都在 `scripts/generate.mjs` 顶部：
`GLOBAL_FLAGS`、`GROUP_ALIASES`、`ACTION_ALIASES`、`defaultVerb()`、`clusterOperations()`。

---

## 8. 发布到 npm

```bash
npm run verify            # 生成器 --check + 测试；prepublishOnly 会自动执行
npm pack --dry-run        # 检查 tarball 内容
npm publish --access public
```

打包要点：

- `package.json` 的 `files` 是白名单：`bin/ src/ api/openapi.json scripts/generate.mjs skills/ README.md AGENTS.md LICENSE`；
  `test/` 不进包（但要在仓库里）；`.npmignore` 只是第二道保险；
- `bin/dockhand.js` 必须带 shebang 且为可执行（`chmod 755`），npm 安装时会自己置位；
- `exports` 额外暴露了 `@qlee/dockhand-cli/commands`（整张命令表）和 `@qlee/dockhand-cli/skill`（skill 文件）；
- `prepublishOnly` = `npm run verify`，保证发布出去的产物与 `api/openapi.json` 一致；
- 发布前记得补上 `repository` / `homepage` / `bugs` 字段（当前留空，避免写错地址）；
- 版本号用 `npm version <patch|minor|major>`，它同时打 git tag。

## 9. Agent Skill

`skills/dockhand/SKILL.md` 是随包发布的 skill（YAML frontmatter：`name` + `description`），
`dockhand skill` 直接打印它，`dockhand skill --path` 打印安装路径：

```bash
mkdir -p ~/.claude/skills/dockhand && dockhand skill > ~/.claude/skills/dockhand/SKILL.md
```

维护规则：

- skill 是 **CLI 的说明书**，不是第二份实现。改了 flag、退出码、内置命令或配置方式，
  必须同步改 `skills/dockhand/SKILL.md`，否则发布出去就是错的文档；
- frontmatter 的 `description` 决定 agent 何时加载它，要写清触发场景（管理 Dockhand、容器、栈、备份等）；
- skill 里出现的每条命令都应当能跑通，示例里的主机一律用 `https://dockhand.example.com` 这类占位符；
- 新增内置命令时，也要在 skill 里补一行入口说明。

## 10. 接入未收录的接口

生成器之后新增的路由、或前端调用的私有接口，用 `raw` 兜底，不要改生成器：

```bash
dockhand raw GET /api/containers --query env=4
dockhand raw POST /api/new-route --data '{"a":1}'
cat payload.json | dockhand raw PUT /api/new-route --stdin
```

---

## 11. 改代码时的注意事项

- `src/commands.js` 里 `aliasMap()` 用了模块级缓存；测试里要改命令表先调用 `resetTable()`。
- `client.js` 区分「文本响应」与「二进制响应」靠 content-type，新增上传/下载接口时注意别把二进制当 UTF-8 读。
- `--dry-run` 不会发请求，但它会走完整的参数校验路径，可以当成廉价的「参数是否合法」检查。
- 新增全局 flag 时，**必须**同时加进 `src/args.js` 的 `BOOLEAN_GLOBAL_FLAGS`（布尔）或
  `src/cli.js` 的 `RESERVED_FLAGS`，以及 `scripts/generate.mjs` 的 `GLOBAL_FLAGS`，否则会被当成接口字段。
- 输出格式只允许 `json / ndjson / table / raw / auto`，新增格式要同时更新 `src/render.js` 与帮助文本。
- 全局 flag 允许写在命令前面（`dockhand --base-url URL containers list`），解析入口是
  `src/cli.js` 的 `commandWords()`；改它要同步 `test/cli.test.mjs` 里的三条扫描用例。
- 没配 base URL 时连接失败，`src/client.js` 会追加配置提示——改文案时同步 README 与 skill。
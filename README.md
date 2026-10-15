# @qlee/dockhand-cli

Dockhand API 的命令行客户端（npm 包名 `@qlee/dockhand-cli`，可执行文件名 `dockhand`）。
366 条命令全部由 `api/openapi.json` 生成，零运行时依赖，只用 Node.js 内置模块。

```bash
dockhand environments list -o table --fields id,name,host
dockhand containers list -e 4 -o table --fields name,state,status
dockhand stacks deploy immich -e 4
dockhand raw GET /api/environments
```

## 安装

```bash
npm install -g @qlee/dockhand-cli   # 提供 dockhand 命令
npx @qlee/dockhand-cli environments list
```

需要 Node.js ≥ 18.17（推荐 20+）。从源码使用：`npm link`，或直接 `node bin/dockhand.js`。

## 配置

**包里不写死任何地址**，请指向你自己的 Dockhand Web 地址：

```bash
dockhand config set base-url https://dockhand.example.com
export DOCKHAND_URL=https://dockhand.example.com     # 环境变量 / CI
dockhand --base-url https://dockhand.example.com environments list   # 单次覆盖
dockhand config show                                 # 密码类字段自动打码
```

解析顺序：flag > 已选实例 > `DOCKHAND_URL` > 配置文件顶层 > `http://localhost:3000`（仅本机开发）。
凭据存放在 `~/.config/dockhand/config.json`（权限 0600）。

## 多实例

管理多台 Dockhand 时，把每台配成命名实例（各自的 URL + 预配置的 Token），之后不必再传：

```bash
dockhand config instance set prod base-url https://prod.example.com
dockhand config instance set prod token dh_xxx        # 提前配好凭据
dockhand config instance set lab base-url https://lab.example.com
dockhand config instance list                          # 实例清单（密钥自动打码）
dockhand config instance show prod / ... remove lab
```

用 `--instance <name>`（简写 `-i`）或 `DOCKHAND_INSTANCE` 选用；不带时用默认实例：

```bash
dockhand containers list                               # 默认实例
dockhand -i prod containers list                       # prod 实例，自动带上它的 token
dockhand --base-url https://lab.example.com stacks ls  # URL 命中实例时自动套用其凭据
export DOCKHAND_INSTANCE=prod                          # 按 shell 会话切换
```

`dockhand login --instance prod --token dh_xxx`（或 `--username … --password …`）则把登录凭据直接存进对应实例条目。

## 登录

实例开启认证时才需要。**推荐用 API token 登录**：token 长期有效，不会像 session
cookie 一样过期，适合 CI、定时任务和 agent 长期使用。

```bash
dockhand login --token dh_xxx          # 校验并长期保存 API token（推荐）
dockhand login --token - < token.txt   # 从 stdin 读 token，不进 shell 历史
dockhand login --username admin --password "$PASS"                    # 存 session cookie（会过期）
dockhand login --username admin --password "$PASS" --save-token ci   # 顺便签发 API token
dockhand login --username admin --password "$PASS" --save-token ci --expires-at 2027-01-01T00:00:00Z
dockhand login --instance prod --token dh_xxx         # 凭据存入 prod 实例
export DOCKHAND_TOKEN=dh_xxx         # CI 也可以只用环境变量
dockhand logout                       # 加 --instance prod 则只清该实例
```

`login --token` 会先调 `GET /api/auth/session` 验证 token 有效再落盘；登录时用的
base URL（`--base-url` / `DOCKHAND_URL`）也会一并记入配置文件。token 可在
Dockhand 网页端创建（失效时间可选，留空则永不过期）。

## 命令模型

```
dockhand <group> [<action>…] [<参数>…] [--flags]
```

- `group` 取路径第一段：`/api/containers` → `containers`；
- 其余静态段原样做 action：`/api/git/repositories/{id}/sync` → `git repositories sync <id>`；
- `{xxx}` 变位置参数，按出现顺序；
- query 参数与 body 字段变 flag，camelCase 转 kebab-case：`destinationId` → `--destination-id`；
- 动词 `list/create/get/update/delete` 只在需要消歧时出现。

```bash
dockhand --help                     # 所有分组
dockhand help containers            # 某分组下的命令
dockhand containers create --help   # 参数、flag、body 字段、响应码
dockhand spec commands              # 整张命令表（JSON）
```

别名随时可用：`dockhand ctr ls` == `dockhand containers list`。

## 常用例子

```bash
# 容器
dockhand containers list -e 4 -o table --fields name,image,state,status
dockhand containers start|stop|restart|pause|unpause <id> -e 4
dockhand containers logs get <id> -e 4 --tail 200
dockhand containers stats get <id> -e 4
dockhand containers update <id> -e 4 --restart-policy unless-stopped

# 创建：单字段 flag、文件、stdin 都行
dockhand containers create -e 4 --name web --image nginx:alpine --restart-policy always
dockhand containers create -e 4 --data-file container.json
echo '{"name":"web","image":"nginx"}' | dockhand containers create -e 4 --stdin

# 数组可重复或逗号分隔；对象直接给 JSON
dockhand containers create -e 4 --name web --image nginx --cmd sh,-c,'sleep 1' \
  --ports '{"80/tcp":[{"host":"8080","container":"80"}]}'

# 镜像、卷、网络、栈
dockhand images pull -e 4 --image nginx:alpine
dockhand volumes list -e 4
dockhand networks list -e 4
dockhand stacks deploy <name> -e 4
dockhand stacks down <name> -e 4

# 写操作先预演
dockhand containers delete web -e 4 --dry-run

# SSE 端点逐行流式输出
dockhand events -e 4
dockhand containers logs stream <id> -e 4

# 上传与下载
dockhand containers files upload web -e 4 --path /tmp --file ./a.txt --form mode=755
dockhand images load --file ./image.tar
dockhand volumes export data -e 4 --out-file data.tar --timeout 0

# 生成器没收录的接口
dockhand raw GET /api/containers --query env=4
dockhand raw POST /api/new-route --data '{"a":1}'
```

## 输出与退出码

| `--output` | 行为 |
|---|---|
| `json`（默认） | 缩进 JSON |
| `ndjson` | 单行 JSON |
| `table` | 对齐表格，`--fields a,b` 挑列 |
| `raw` | 原始响应体 |
| `auto` | 自动判断 |

| 退出码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 一般错误（HTTP 5xx） |
| 2 | 用法错误（未知 flag、缺参数、缺必填 body、类型不匹配） |
| 3 | 认证/权限（401、403） |
| 4 | 未找到（404） |
| 5 | 冲突（409） |
| 6 | 限流（429） |
| 7 | 网络/超时 |

连接阶段失败（ECONNREFUSED、EHOSTUNREACH 等）会在报错前自动重试 3 次；错误
信息末尾附带真实 errno，如 `fetch failed (EHOSTUNREACH)`。`--verbose` 可看到
每次重试。

## Shell 补全

```bash
dockhand completion bash > /etc/bash_completion.d/dockhand
dockhand completion zsh  > "${fpath[1]}/_dockhand"
dockhand completion fish > ~/.config/fish/completions/dockhand.fish
```

## Agent Skill

包内自带一份描述本 CLI 的 skill：

```bash
dockhand skill --path                              # 文件位置
dockhand skill > ~/.claude/skills/dockhand/SKILL.md
```

内容覆盖配置、认证、命令模型、类型化 flag、输出模式、退出码、**agent 安全守则**
（先 `--dry-run`、先读后写）与排障表。源码：[skills/dockhand/SKILL.md](skills/dockhand/SKILL.md)。

## 跟随服务端版本重新生成

服务端升级后，用它自己的 spec 重新生成命令表：

```bash
dockhand generate --fetch https://dockhand.example.com/openapi.json
# 源码目录里等价于：
npm run generate:fetch -- https://dockhand.example.com/openapi.json
```

## 发布

```bash
npm run verify            # 生成器 --check + 测试，publish 前自动执行
npm publish --access public
npm pack --dry-run        # 先看 tarball 内容
```

改动前请先读 [AGENTS.md](AGENTS.md)。

## License

MIT
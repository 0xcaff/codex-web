# Linux 共享会话与手机访问

本项目是 **0xcaff/codex-web**。Linux 共享模式提供共享会话、Desktop 工具兼容和安装时选择局域网访问的功能。

这份指南用于 Linux 上的长期共享后台。所有安装命令在运行 Codex 的那台电脑上执行，使用你平时的 Linux 用户；手机只需要浏览器。示例以 Ubuntu/Debian 和 Bash 为准，不需要 frp、Nginx，也不要求先安装 Desktop 应用。

**当前没有网页登录认证。** `codex login` 登录的是你的 OpenAI 账号，不能保护网站。先选择“仅本机”；只有确认局域网设备可信时才启用手机直连。公网或多人共用网络需要另外配置私有网络或认证入口。

新用户按顺序完成：**准备依赖 → 下载并构建 → 选择访问范围 → 验证共享会话**。已有安装可直接看[日常管理与更新](#5-日常管理与更新)。

## 它解决了什么

- 网页和 `codex-shared` 终端入口连接同一个后台，可以打开同一个会话。
- 网页重启时，后台继续运行，正在执行的任务不会因为网页服务重启而停止。
- Desktop 工具连接实际打开的网页，可以读取会话、列出会话；网页重启后可以重新连接。
- 安装时选择“仅本机”或“局域网”。修复手机通过普通 HTTP 打开时因 UUID 接口缺失导致的白屏。
- 构建时压缩网页文件，并压缩实时会话同步，减少手机首次打开时的下载量。会话内容和工具目录仍完整传输。
- 刷新同一标签页时复用未改变的大块数据，减少旧对话和配置的重复下载；内容更新后仍同步最新数据。

它不会自动把所有原生 CLI、Desktop、VS Code 会话接入同一个后台。需要共享的终端会话请通过 `codex-shared` 打开。

## 1. 准备电脑

需要 Linux、可用的 `systemd --user`、Python 3、Node.js 22.12 或更高版本、npm、Codex CLI 0.160.1 或更高版本，以及 `websocat`。共享后台已验证 Codex **0.160.1**，安装器允许更高版本，但更高版本仍需验证。

先安装系统工具；这一步需要 sudo，后面的 npm、构建和安装服务使用普通用户执行：

```bash
sudo apt update
sudo apt install git curl ca-certificates unzip patch python3 build-essential
```

`build-essential` 用于没有预编译包时编译原生依赖。首次构建会下载约 **567 MiB** 的 Desktop 安装包；建议电脑预留约 **5 GiB** 空间，供下载、解包、依赖和安装快照使用。这个安装包下载到电脑，手机不会下载整个 Desktop 安装包。

### Node.js 与 npm

先检查 `node --version` 和 `npm --version`。如果 Node 已达到 22.12，跳过此小节。不要直接假定 Ubuntu 自带的软件源提供的版本足够新。

没有合适版本时，可按 [nvm 官方安装方式](https://github.com/nvm-sh/nvm#install--update-script)安装 Node 22：

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm install 22
nvm use 22
node --version
npm --version
```

若已有自定义 `NVM_DIR`，沿用原来的目录即可。也可使用 [Node.js 官方下载页](https://nodejs.org/en/download)提供的安装方式。

### Codex CLI 与账号

检查 `codex --version`。首次安装 Codex 的用户可以选择已验证版本：

```bash
npm install -g @openai/codex@0.160.1
codex --version
```

已有符合要求的 CLI 时不用重装。如果已有较新的 CLI，不要为了网页降级原来的命令；如果原来的 CLI 太旧，又想保持它不变，可以单独安装共享后台用的版本：

```bash
npm install --prefix "$HOME/.local/share/codex-web/cli" @openai/codex@0.160.1
```

这种独立安装方式在后文每次执行安装器时增加：

```text
--codex "$HOME/.local/share/codex-web/cli/node_modules/.bin/codex"
```

先用原来的 Codex 登录；登录过程中按终端提示在浏览器输入设备代码：

```bash
codex login --device-auth
codex login status
```

如果只安装了上述独立版本，使用 `"$HOME/.local/share/codex-web/cli/node_modules/.bin/codex" login --device-auth` 登录，并用同一路径执行 `login status`。

共享后台默认使用 `~/.codex` 中的登录和配置。项目没有修改全局 `config.toml`，也没有替换原来的 `codex` 程序。

### websocat

`websocat` 负责网页与共享后台之间的连接。Ubuntu/Debian 不应直接假定可以通过 `apt install websocat` 安装；官方提供了[预编译下载](https://github.com/vi/websocat/releases/tag/v1.14.1)。

先运行 `websocat --version`；已有可用版本时跳过下载。

先运行 `uname -m` 查看电脑架构。普通 Intel/AMD 64 位电脑输出 `x86_64`，执行：

```bash
mkdir -p "$HOME/.local/bin"
curl -fL --retry 2 https://github.com/vi/websocat/releases/download/v1.14.1/websocat.x86_64-unknown-linux-musl -o "$HOME/.local/bin/websocat"
chmod 755 "$HOME/.local/bin/websocat"
export PATH="$HOME/.local/bin:$PATH"
websocat --version
```

ARM 64 位电脑通常输出 `aarch64`，把下载文件名改成 `websocat.aarch64-unknown-linux-musl`；其他架构选择发布页对应的 Linux 文件。完整共享安装流程主要在 x86_64 Linux 上验证。

最后确认全部依赖可用：

```bash
git --version
node --version
npm --version
codex --version
python3 --version
websocat --version
systemctl --user show-environment >/dev/null
```

独立安装 Codex 时将检查命令换成独立版本的完整路径。最后一条用于确认用户服务管理器可连接。若提示 `Failed to connect to bus`，先解决 Linux 用户会话问题；只安装 Python 或在命令前加 sudo 不能解决它。没有 systemd 用户服务的容器和系统不能使用本指南的长期服务安装方式。

## 2. 下载并构建

下载源码、安装依赖并构建：

```bash
git clone https://github.com/0xcaff/codex-web.git
cd codex-web
npm ci
```

若使用 GitHub 的 **Code → Download ZIP**，解压后进入包含 `package.json` 的目录，再运行 `npm ci`。确认下载的版本包含 `scripts/install-services.py` 和 `runtime/codex-shared`；旧版本没有本指南中的共享安装功能。

`npm ci` 会自动执行构建，不必再重复运行 `npm run build`。首次下载和解包可能需要几分钟；终端尚未退出时不要关闭它。正常结束后应同时存在 `src/server/main.js` 和 `scratch/asar/webview/index.html`。任何一步失败时先修复错误，再继续安装服务。

## 3. 选择访问范围并启动

只在电脑本机使用：

```bash
python3 scripts/install-services.py --access local --restart
```

允许同一局域网的手机访问：

```bash
python3 scripts/install-services.py --access lan --port 8214 --restart
```

`local` 监听 `127.0.0.1`；`lan` 监听 `0.0.0.0`。手机应打开 `http://电脑的局域网IP:8214`，例如 `http://192.168.1.100:8214`。电脑和手机需要互相可达；如果系统防火墙或路由器隔离设备，仍需配置对应的网络规则。

在电脑上运行 `hostname -I` 查找局域网 IP；有多个地址时选择手机能够访问的那张网卡，例如 Wi-Fi/有线网卡的 `192.168.x.x` 地址。手机通常应连接同一局域网，不能在手机上用 `127.0.0.1` 代替电脑地址——它指的是手机自己。

**网页没有内置登录保护。只在可信局域网使用，不要直接暴露到公网。** 能打开网页的人可以用这个电脑用户的权限操作 Codex。公网入口需要另行配置 VPN、SSH 隧道或认证代理。

可选参数：

| 参数                           | 用途                                        |
| ------------------------------ | ------------------------------------------- |
| `--host 192.168.1.100`         | 只监听指定地址，与 `--access` 二选一        |
| `--port 9000`                  | 更改端口                                    |
| `--codex /路径/codex`          | 指定 Codex；支持官方 npm 启动器或原生二进制 |
| `--node /路径/node`            | 指定 Node.js                                |
| `--websocat /路径/websocat`    | 指定 websocat                               |
| `--app-tools /路径/server.mjs` | 指定已安装的官方 Desktop 工具插件           |
| `--dry-run`                    | 只显示安装配置，不修改服务                  |
| `--restart`                    | 安装后启动或重启网页服务                    |

网络选择保存到 `~/.config/codex-web/server.json`。以后更新时，不传网络参数就保留上次的选择。

## 4. 验证电脑和手机是否共享同一会话

先检查两个后台服务：

```bash
systemctl --user is-active codex-shared.service codex-web.service
node scripts/check-connection.cjs http://127.0.0.1:8214
```

服务应输出两行 `active`，连接检查应输出 `OK: WebSocket upgrade returned 101.`。如果配置了自定义地址或端口，把检查网址改成对应值。这条命令只检查实时连接，不代表模型账号和所有工具都已验证。

按下面的顺序验证基本共享功能：

1. 在电脑打开 `http://127.0.0.1:8214`；启用 LAN 后，手机打开 `http://电脑局域网IP:8214`。
2. 在项目工作目录打开终端，运行 `~/.local/bin/codex-shared`，发送一句容易辨认的话，例如“只回复：共享测试成功”。这会使用你的模型额度。
3. 在手机网页的会话列表中刷新或找到这个新会话并打开。确认能看到刚才的消息和回复。
4. 在手机这个会话继续发送一条消息，确认终端能看到同一会话的新内容。
5. 在网页新建会话并发送一条消息，再在电脑执行 `~/.local/bin/codex-shared resume`，选择刚才的网页会话，确认能继续对话。

需要共享的新终端会话必须使用 **`codex-shared`**。普通 `codex`、Desktop 和 VS Code 启动的后台不会自动变成这个共享后台；网页看到了历史记录，也不等于接入了原后台正在运行的任务。

网页和终端可共同操作，但不要同时对同一会话发送两个新任务。一个客户端发出任务后，可以在另一个客户端观察输出或处理可见的操作。

## 5. 日常管理与更新

日常打开网页和终端即可，不需要每次重新构建或运行安装器：

```bash
~/.local/bin/codex-shared
~/.local/bin/codex-shared resume
```

指定会话时使用 `~/.local/bin/codex-shared resume <会话ID>`。这里的尖括号表示要替换成实际 ID，不要原样输入。

后台由两个用户服务管理：`codex-shared.service` 负责运行会话，`codex-web.service` 负责网页。

```bash
systemctl --user status codex-shared.service codex-web.service
systemctl --user restart codex-web.service
journalctl --user -u codex-web.service -n 50 --no-pager
journalctl --user -u codex-shared.service -n 50 --no-pager
```

网页卡住时可以只重启 `codex-web.service`。重启或停止 `codex-shared.service` 会中断这个后台正在执行的任务，应在任务结束后操作。

使用 Git 下载的用户，在原源码目录更新：

```bash
git pull --ff-only
npm ci
python3 scripts/install-services.py --restart
```

如曾使用独立 CLI 或 `--app-tools`，再次安装时继续传入对应路径。`--app-tools` 是安装时参数，不保存在网络设置文件中。ZIP 用户重新下载所用分支的新版本，进入新解压的目录执行 `npm ci` 和安装命令；ZIP 目录不能直接 `git pull`。

安装器把程序和依赖保存成版本快照，再切换 `current` 入口。更新时只重启网页，不主动重启共享后台；旧任务继续使用原来启动的程序。后台程序升级在共享后台下一次启动时生效。

用户服务随用户会话启动。若希望退出 SSH、退出登录或重启后无人登录时也持续运行，可开启 systemd linger：

```bash
loginctl enable-linger "$USER"
loginctl show-user "$USER" -p Linger
```

应显示 `Linger=yes`；部分系统会要求管理员授权。首次安装仍需在正常用户登录会话中执行，不应通过 `sudo python3 scripts/install-services.py` 安装到 root 用户。

需要让当前 Bash 终端的交互式 `codex` 也进入共享后台，可选择临时执行：

```bash
source "$HOME/.local/share/codex-web/current/bin/shared-shell.bash"
```

只影响当前 shell；`codex login` 等管理命令仍走原程序。执行 `unset -f codex` 或关闭该终端即可恢复。初次安装不会自动修改 `.bashrc`，建议先确认共享正常再使用这个可选入口。

### 卸载网页与共享服务

先结束共享后台的任务，再停用服务：

```bash
systemctl --user disable --now codex-web.service codex-shared.service
rm -f "$HOME/.config/systemd/user/codex-web.service" "$HOME/.config/systemd/user/codex-shared.service"
systemctl --user daemon-reload
```

然后可删除安装器创建的 `~/.local/bin/codex-shared` 链接，以及 `~/.local/share/codex-web`、`~/.local/state/codex-web`、`~/.config/codex-web` 目录以释放空间。**不要删除 `~/.codex`**：它包含原有 Codex 配置、登录和会话历史。若曾手动添加 Bash 路由，移除对应的 `source` 行。仅为此工具开启的 linger 可按需执行 `loginctl disable-linger "$USER"`；若还有其他长期用户服务则保留。

## 常见问题

| 现象                              | 检查与处理                                                                                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex/websocat/node is required` | 缺少依赖或当前终端 PATH 未包含它。先运行对应的 `--version`；也可通过安装器的 `--codex`、`--websocat`、`--node` 指定完整路径。                                                |
| 提示 Node 或 Codex 版本过低       | 检查当前终端实际使用的版本；按准备部分安装合适版本，再重新构建/安装。已有旧 Codex 可为共享后台单独安装 0.160.1。                                                             |
| `npm ci` 下载失败                 | 检查电脑是否能访问 npm、GitHub 和 Desktop 下载地址；修复网络后重新执行 `npm ci`。安装器不能替代失败的构建。                                                                  |
| `patch` 或兼容补丁报错            | 不要跳过报错继续安装；确认使用完整源代码及锁定的 Desktop 版本，再重新执行 `npm ci`。                                                                                         |
| `Failed to connect to bus`        | 用户服务管理器不可用。通过正常用户登录/SSH 会话操作，并确认系统支持 `systemd --user`。                                                                                       |
| 本机能打开，手机不能              | 确认安装时用了 `--access lan`，手机填写电脑 IP，双方网络可达；检查防火墙、访客 Wi-Fi 和设备隔离。用 `ss -ltnp 'sport = :8214'` 查看监听地址；仅 `127.0.0.1` 不能供手机直连。 |
| 手机一直停在 logo                 | 执行连接检查，查看网页服务日志；实时连接应返回 101。只下载到网页文件并不足以进入会话。                                                                                       |
| 网页看不到终端正在运行的任务      | 确认任务由 `codex-shared` 启动，并且两端选择同一会话；普通 CLI 会话不会自动变成共享后台的 live session。                                                                     |
| 模型登录或额度错误                | 用原来的 CLI 检查 `codex login status`，再查看共享后台日志；网站可打开不表示账号或额度正常。                                                                                 |
| 没有 Desktop 工具                 | 该插件是可选依赖，不随仓库下载。见下方 Desktop 工具条件；没有插件仍可进行基本共享对话。                                                                                      |

## 手机下载量与启动 logo

网页沿用了 Desktop 的界面，首次打开需要下载较大的 JavaScript 文件，还会同步会话状态。构建自动生成 gzip 和 Brotli 文件；浏览器支持哪种就使用哪种，不支持时仍可下载原文件。实时连接也会协商压缩。压缩不会删除历史记录或工具功能，手机仍需解析完整的数据，因此加载时间也取决于手机性能。

重复进入旧对话或刷新时，网页会缓存较大的数据块。服务器每次仍读取当前状态，只有 SHA-256 校验值完全一致的数据才发送简短引用；手机校验缓存并还原原消息。大块数据还会分段复用，少量字段变化时只需传输变化附近的部分。新消息和发生变化的数据正常传输。缓存缺失或损坏时自动补传，并保持消息顺序，不会为了省流量删掉历史。

缓存保存在浏览器的 IndexedDB 中，按标签页和网页服务进程区分，最多 64 MiB、4,096 项，每个参与缓存的消息数据块不超过 8 MiB，有效期一小时；过期数据在后续写入时清理。缓存包含会话数据，清除该网站的浏览器存储即可删除。首次打开、清除缓存、网页服务重启或内容变化后仍会产生下载，实际节省量因对话而异。浏览器无法使用存储时会降级，网页仍可使用。

如需关闭这项缓存，在 Web 服务进程的环境变量中设置 `CODEX_WEB_IPC_CACHE=0` 后只重启 Web 服务即可。共享后台无需重启。

如果文件下载完仍停在 logo，请检查实时连接。网页文件能下载，不代表实时连接已经建立：

```bash
node scripts/check-connection.cjs http://127.0.0.1:8214
node scripts/check-connection.cjs https://你的域名
```

正常输出 `WebSocket upgrade returned 101`。如果本机正常、公网返回 `HTTP 200`，说明公网路径把实时连接当成普通网页处理了，应检查代理转发。这个命令不带浏览器的登录 cookie；已配置认证的入口可能返回 401/403，需要在已登录的浏览器中继续验证。

## Nginx + frp 公网入口

可以保留现有的 `frp type = "http"` 和 Nginx HTTPS 入口。Nginx 需要将实时连接路径 `/__backend/ipc` 原样转发到 frps 的 HTTP 入口，并转发升级连接所需的请求头。

在域名对应的 HTTPS `server` 内加入下面的 `location`，把 `127.0.0.1:8080` 改成你现有 `proxy_pass` 使用的 frps HTTP 地址和端口。这里的 8080 只是示例，不能直接假定它就是你的端口。保留现有证书、普通网页路由和认证配置。

```nginx
location = /__backend/ipc {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
}
```

`proxy_pass` 不要在上游地址后添加 `/` 或改写路径；这里必须保留 `/__backend/ipc`。`Host` 也必须正确传递，因为 frps 的 HTTP 代理会按域名选择本机服务。

如果认证原本只写在 `location /` 中，新建的实时连接 `location` 不会自动继承它。需要把认证提升到 `server` 层或同时应用到两处，确保网页和实时连接都受保护。

在公网服务器上检查配置，成功后平滑重新加载：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

再次执行公网连接检查，应返回 101，再在手机浏览器中刷新。Nginx 的升级转发要求见[官方说明](https://nginx.org/en/docs/http/websocket.html)，frps 的按域名转发配置见[官方示例](https://gofrp.org/en/docs/examples/vhost-http/)。

## Desktop 工具的条件

程序默认查找你已安装的官方 `codex-app-tools` **0.1.5** 插件：

```text
~/.codex/plugins/cache/openai-bundled/codex-app-tools/0.1.5/server.mjs
```

项目只在本机生成兼容副本，没有把官方插件文件、账号凭据或工具数据提交到 GitHub。如果没有这个插件，共享会话仍能使用，但不会提供这组 Desktop 工具。

工具需要至少一个已经加载完成的网页标签页。已在后台加载的 CLI 会话可能继续保留旧的工具配置；请等当前任务结束、关闭该会话的客户端后再从网页打开，或者在网页里新建会话。程序不会强制终止任务来刷新工具。

已验证的是会话工具调用和网页重连。浏览器自动控制、Linux computer use，以及其他插件的登录或权限问题不属于这次修复。

## 开发与验证

```bash
npm test
```

安装流程测试（使用临时目录，并拦截服务命令，不会修改日常服务）：

```bash
npm run test:install
```

实际模型测试：

```bash
npm run test:integration
```

实际测试需要 Google Chrome、已登录的 Codex 和上述官方插件，会消耗少量模型额度。它使用独立的临时目录、后台和端口 8220，不修改日常用户服务。测试结束删除临时登录文件；私有日志保留在输出的临时目录中。

可以通过 `CODEX_TEST_CODEX`、`CODEX_TEST_BROWSER`、`CODEX_TEST_APP_TOOLS`、`CODEX_TEST_HOST`、`CODEX_TEST_PORT` 调整测试环境。比如设置 `CODEX_TEST_HOST` 为电脑的局域网 IP，可以验证普通 HTTP 地址下的移动端页面。

构建兼容补丁针对 Desktop `26.901.41123`，共享后台已测试 Codex `0.160.1`。上游 Desktop 改变内部结构时，补丁会明确报错，需要重新适配；更高的 CLI 版本仍需验证。

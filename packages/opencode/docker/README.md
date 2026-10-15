# Sandbox 镜像 — 极简基底 + mise 多版本 + 预装依赖缓存

OpenSandbox 沙箱容器镜像，基于 `ubuntu:24.04` 极简基底（不依赖 code-interpreter 的多语言运行时），
通过 [mise](https://mise.jdx.dev/) 管理多版本 Node.js / pnpm，并预装依赖缓存以加速项目初始化。
另内置常驻 CDP 浏览器（`0.0.0.0:9222` + `/viewer` 实时画面）。

体积参考：纯极简基底 ~2.3G；叠加 mise 多版本（~340M）+ 预装缓存（~800M）后 ~3.4G。
快照（docker commit）耗时与 rootfs 体积近似线性：2.3G→~15s，3.4G→~30s（code-interpreter 9.8G 为 86s）。

## 目录结构

```
docker/
├── Dockerfile                  # 沙箱镜像构建文件（极简基底 + mise + 预装缓存 + CDP）
├── Dockerfile.code-interpreter.bak  # 旧方案备份（code-interpreter 基底，~10GB）
├── README.md                   # 本文档
├── package.json                # pnpm workspace root（构建时用）
├── pnpm-workspace.yaml         # workspace 配置
├── opt/                        # 镜像内组件（COPY 进 /opt/）
│   ├── opencode-lsp-daemon/    # LSP daemon（/usr/local/bin/opencode-lsp-agent）
│   ├── sandbox-plugin-agent.ts # 沙箱 session 插件 agent（V2 sandbox 执行）
│   ├── sandbox-plugin-npm.ts
│   ├── opencode-pty-agent.ts   # 交互式 PTY agent（bun-pty）
│   └── cdp-browser/            # 常驻 CDP 浏览器（cdp-gateway + /viewer + 启动脚本）
└── packages/                   # 模板项目（每个子目录 = 一个模板，用于预装缓存）
    ├── vite5/  ├── vite8/      # （含 package-lock.json）
    ├── react-antd5/            # react18 + antd5 + tw3 + tiptap2（旧栈，现网 antd ^5.x 项目）
    ├── react-antd6/            # react19 + antd6 + tw4 + tiptap3 + rrweb（新栈）
    └── xybot-common/           # xybot 私有 scope 高频包（tarball 预热）
```

## 版本管理（mise）

使用 [mise](https://mise.jdx.dev/) 的 **shims 模式**管理运行时版本。
shims 放在 `~/.local/share/mise/shims/`，PATH 最前面。
调用 `node`/`pnpm` 时，shim 自动检测当前目录的版本文件，路由到正确版本的二进制。

### 预装版本

| 工具 | 预装版本 | 默认版本 |
|------|---------|---------|
| Node.js | 18, 20, 22, 24 | 24 |
| pnpm | 8, 9, 10, 11 | 10 |

默认版本由 `/root/.config/mise/config.toml` 的 `[tools]` 钉死；OpenSandbox bootstrap
重置 PATH 时经 `/usr/local/bin/<bin>` → shims 的 symlink 兜底（保持版本路由）。

### 版本切换

通过 exec 接口执行命令切换版本：

```bash
# 方式一：mise use（修改当前目录的 mise.toml）
cd /workspace && mise use node@20 pnpm@9

# 方式二：mise install + mise.toml（项目已有版本声明）
cd /workspace && mise install

# 方式三：直接设置环境变量（临时生效）
MISE_NODE_VERSION=20 node -v
```

### 版本文件检测（自动）

mise 支持检测以下版本文件（已全部启用）：

| 文件 | 示例 |
|------|------|
| `mise.toml` | `[tools] node = "20"` |
| `.tool-versions` | `node 20.18.0` |
| `.nvmrc` | `20` |
| `.node-version` | `20.18.0` |
| `package.json` `devEngines` | `"devEngines": { "node": "20" }` |

shims 在每次调用时自动检测，无需 shell hook。

## 私有 registry（@xybot 系 scope）

镜像内 `/root/.npmrc` 配置了阿里云制品仓库（`packages.aliyun.com/.../npm-registry/`），
覆盖 `@xybot` / `@xybot-icons` / `@xbot-fe` / `@lightfish` 四个私有 scope，
沙箱内任意目录 `npm`/`pnpm` install 均可直接解析私有包（项目自带 `.npmrc` 时项目配置优先）。

- 全局预装 `@xybot/cli`（`xybot dev` / `xybot build` 构建工具链）：项目 `node_modules`
  未安装时也能直接调用，装好项目依赖后优先走项目本地 bin
- `packages/xybot-common/` 模板预热高频私有包的 tarball（版本取自现网项目实际锁定值），
  跨会话重装同一版本时命中 npm tarball cache
- **token 轮换时需重建镜像**：`_authToken` 写在 Dockerfile 第 3b 步，随镜像分发，
  暴露面与项目 `.npmrc` 等同（内部 SaaS）

> 观察（2026-10-12，近 10 天 26 个 appId 会话）：项目 `.npmrc` 普遍带 `engine-strict = true`，
> AI 安装时常需追加 `--config.engine-strict=false` 绕过 engines 检查（部分包未声明 node@24 支持）。
> 镜像层无法覆盖项目级 `.npmrc`，此为项目侧约束。

## 预装缓存

### npm cache — tarball 缓存（通用）

npm cache 目录设为 `/opt/package-cache-base/npm`（经 `npm_config_cache` 环境变量，
对任意 node/pnpm 版本生效），构建时已填充所有模板的 tarball。
**tarball 缓存不依赖 node/pnpm 版本，所有版本共享。**

### npm — 预装 node_modules

构建时对每个模板项目执行 `npm install`，将完整的 `node_modules` 保存到镜像内：

```
/opt/preload/<template>/node_modules   # 预装的 node_modules
/opt/preload/<template>/package.json
/opt/preload/<template>/package-lock.json（如有）
```

使用方式：

```bash
cp -a /opt/preload/vite5/node_modules .
npm install --prefer-offline   # 只补差异包，跳过已有包
```

### pnpm store — 预热 pnpm@10 格式

pnpm store 配置为 `/opt/pnpm-store`（镜像层 overlay），构建时用默认 pnpm@10 预热所有模板。
**只有 v10 store 格式被预热**：pnpm 8/9/11 的 store 子目录格式不同，命中不了 v10 预热内容，
切换旧版 pnpm 后首次 install 走网络下载（后续命中各自的 store）。

virtual-store 配置为 `/tmp/pnpm-vs`（overlay 本地盘）：`/workspace` 为 NFS PVC 时，
所有重 IO 在本地盘完成，NFS 上只写轻量 symlink；store 与 virtual-store 同在 overlay，
hardlink 生效。

## 镜像内缓存清单

| 路径 | 用途 | 大小（参考） |
|------|------|-------------|
| `/opt/preload/<template>/node_modules` | npm 预装 node_modules | 每个 100-200MB |
| `/opt/package-cache-base/npm` | npm tarball cache（通用，含私有包） | ~100-150MB |
| `/opt/pnpm-store/v10` | pnpm@10 store（预热） | ~190MB |
| `/root/.local/share/mise/installs/node/*` | mise 管理的 Node.js 版本 | 每个 ~80MB |
| `/root/.local/share/mise/installs/npm/pnpm/*` | mise 管理的 pnpm 版本 | 每个 ~5MB |

## 构建命令

```bash
cd packages/opencode

docker build \
  -t opencode-opensandbox:local \
  -f docker/Dockerfile \
  .
```

### 前置：amd64 需预下载 codegraph 二进制（gitignore 不入库）

`docker/opt/codegraph/codegraph-linux-x64.tar.gz`（~55MB）缺失时 amd64 构建会失败。下载（断点续传应对网络抖动）：

```bash
curl -fSL -C - -o packages/opencode/docker/opt/codegraph/codegraph-linux-x64.tar.gz \
  https://github.com/colbymchenry/codegraph/releases/download/v1.4.1/codegraph-linux-x64.tar.gz
```

单个模板预装失败只打 WARN 跳过，不阻断构建（缓存为加速项，非功能项）。

## 添加新模板项目

1. 在 `packages/` 下创建新目录，放入 `package.json` 和 `package-lock.json`

```
packages/
└── next15/
    ├── package.json
    └── package-lock.json
```

2. 重新构建镜像

### 生成 lockfile

```bash
cd packages/next15
npm install --ignore-scripts --cache /tmp/npm-cache-tmp
# package-lock.json 自动生成
```

## 与旧方案（code-interpreter 基底）的区别

| | 旧方案（.bak） | 现方案 |
|---|---|---|
| 基底 | `opensandbox/code-interpreter`（~10GB，含 Python/Go/JVM） | `ubuntu:24.04` 极简（~2.3GB + 缓存） |
| rootfs | ~9.8G，快照 86s | ~3.4G，快照 ~30s |
| 版本管理 | mise 管理多版本 Node + pnpm | 同左（保留） |
| 预装缓存 | npm cache + node_modules + pnpm store | 同左（保留） |
| CDP 浏览器 | 独立变体镜像（docker/browser-cdp，已并入） | 内置（cdp-gateway 9222 + /viewer） |
| 自研组件 | LSP daemon / sandbox-plugin / PTY agent | 同左（保留） |

## 注意事项

- 镜像基于 `ubuntu:24.04`，自带 python3 + uv（tsinghua 源）；Go/JVM 运行时不再内置
- npm/pnpm registry 设为 `https://registry.npmmirror.com`（npm 经 `npm_config_registry` ENV，pnpm 经 global rc）
- Node 二进制下载走 npmmirror 镜像（`MISE_NODE_MIRROR_URL`），构建加速
- 模板项目的 lockfile 应定期更新以保持缓存新鲜
- pnpm 11 要求 Node.js 22+，如果项目用 node@18 + pnpm@11 会报错（mise 不干预这种组合）
- 常驻 CDP 浏览器用 `/opt/cdp-browser/cdp-browser.sh start` 拉起（幂等）

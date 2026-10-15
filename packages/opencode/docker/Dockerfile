# syntax=docker/dockerfile:1
# OpenSandbox 沙箱镜像 —— 极简基底（ubuntu:24.04）+ mise 多版本 + 预装依赖缓存 + 常驻 CDP 浏览器
#
# 基于 ubuntu:24.04 + 兜底 Node 24 构建（不依赖 code-interpreter 的 Python/Go/JVM 多语言运行时），
# 在极简基底上叠加三层能力：
#   1. mise 多版本 Node 18/20/22/24 + pnpm 8/9/10/11（shims 自动路由版本文件，默认 node@24 + pnpm@10）
#   2. 预装依赖缓存：npm tarball cache（/opt/package-cache-base/npm，跨 node/pnpm 版本共享）
#      + 模板 node_modules（/opt/preload/<template>）+ pnpm store（/opt/pnpm-store，仅预热 pnpm@10 格式）
#   3. 常驻 CDP 浏览器（headless Chromium + cdp-gateway 0.0.0.0:9222，含 /viewer 实时画面页）
# rootfs 体积参考：纯极简 ~2.3G；叠加 mise 多版本（~340M）+ 预装缓存（~800M）后 ~3.4G。
# 快照（docker commit）耗时与 rootfs 体积近似线性：2.3G→~15s，3.4G→~30s（code-interpreter 9.8G 为 86s）。
#
# 依赖 OpenSandbox server 注入 bootstrap.sh（entrypoint 被其接管，见调研结论），
# 镜像自身 ENTRYPOINT 不参与 execd 启动，仅提供运行环境（bash/node/pnpm/git 等）。
# 支持 --platform linux/amd64 与 linux/arm64（Node 二进制按 TARGETARCH 自动选择）。

# ── 阶段 0：按目标架构下载 Node 官方二进制 ──
FROM ubuntu:24.04 AS node-dl
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends curl xz-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /out \
    && if [ "$TARGETARCH" = "amd64" ]; then ARCH=x64; else ARCH=arm64; fi \
    && curl -fsSL "https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-${ARCH}.tar.xz" | tar -xJ -C /tmp

FROM ubuntu:24.04
USER root

# ── 1. 基础工具 ──
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl wget git unzip zip tar bash xz-utils ripgrep util-linux \
    python3 python3-venv python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --break-system-packages --no-cache-dir uv \
      -i https://pypi.tuna.tsinghua.edu.cn/simple
ENV PYTHONUNBUFFERED=1

# ── 2. Node.js 24（兜底运行时；mise shims 接管后作为 PATH 后段 fallback）──
ENV NODE_ROOT=/opt/node
COPY --from=node-dl /tmp/node-v24.19.0-linux-* $NODE_ROOT/24/
ENV PATH="$NODE_ROOT/24/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"

# ── 3. npm 源与缓存（ENV 形式，对任意 node 安装位置生效）──
# 不用 `npm config set --global`：它写入当前 npm prefix 的 etc/npmrc，
# mise 切换 node 版本后 prefix 变化会丢配置；ENV 始终生效（pnpm 同样读取 npm_config_*）。
ENV npm_config_registry=https://registry.npmmirror.com
ENV npm_config_cache=/opt/package-cache-base/npm

# ── 3b. 私有 registry（阿里云制品仓库，@xybot 系 scope）──
# 写入全局 /root/.npmrc：沙箱内任意目录 npm/pnpm install 均可解析私有包
# （项目自带 .npmrc 时项目配置优先，配置等价不冲突）。
# 注意：_authToken 随镜像分发给所有沙箱实例，与项目 .npmrc 分发面等同（内部 SaaS）；
# token 轮换时需重建镜像。
RUN cat > /root/.npmrc <<'EOF'
@xybot:registry=https://packages.aliyun.com/604c1a6bf11bae7ca07d6ad3/npm/npm-registry/
@xybot-icons:registry=https://packages.aliyun.com/604c1a6bf11bae7ca07d6ad3/npm/npm-registry/
@xbot-fe:registry=https://packages.aliyun.com/604c1a6bf11bae7ca07d6ad3/npm/npm-registry/
@lightfish:registry=https://packages.aliyun.com/604c1a6bf11bae7ca07d6ad3/npm/npm-registry/
//packages.aliyun.com/604c1a6bf11bae7ca07d6ad3/npm/npm-registry/:_authToken=945e1023-d78b-46c0-b061-1a3fc2723cb2
EOF

# ── 4. mise 多版本管理（shims 模式）──
# 预装 Node 18/20/22/24 + pnpm 8/9/10/11；config.toml 钉默认 node@24 + pnpm@10。
# shims 置于 PATH 最前，按当前目录版本文件（.nvmrc/.node-version/mise.toml/.tool-versions）自动路由。
# 注：不要设 MISE_NODE_MIRROR_URL——npmmirror 镜像被 mise 拼成 404 路径（实测 2026-10-12），
# nodejs.org 直连即可（阶段 0 的 node-dl 同样走官方源）。
# mise 经 npm 安装（npmmirror 稳定）；curl mise.run 会从 GitHub 下二进制，国内网络易断流
# （实测 2026-10-12 两次构建一次成功一次 curl 23）。
# 版本钉 2026.10.7：主包与平台子包（linux-x64/arm64）registry 同步的交集最新版——
# 主包 2026.10.8 已发布但 @jdxcode/mise-linux-x64@2026.10.8 缺失（发布/同步延迟，
# 实测 2026-10-12），latest 会解析失败。
RUN npm install -g mise@2026.10.7 \
    && mkdir -p /root/.config/mise \
    && cat > /root/.config/mise/config.toml <<'EOF'
[tools]
node = "24"
"npm:pnpm" = "10"

[settings]
trusted_config_paths = ["/"]
idiomatic_version_file_enable_tools = ["node", "pnpm", "npm", "bun"]
status = { show_env = false, show_tools = false }
EOF
RUN mise install node@18 node@20 node@22 node@24 \
      npm:pnpm@8 npm:pnpm@9 npm:pnpm@10 npm:pnpm@11 \
    && mise reshim
ENV MISE_DATA_DIR=/root/.local/share/mise
ENV PATH="/root/.local/share/mise/shims:$NODE_ROOT/24/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"
# pnpm store 在镜像层（overlay 读快）；virtual-store 在容器本地盘（写快）。
# /workspace 为 NFS PVC 时所有重 IO 留在 overlay，NFS 上只有轻量 symlink；两者同 fs hardlink 生效。
RUN pnpm config set registry https://registry.npmmirror.com --global \
    && pnpm config set store-dir /opt/pnpm-store --global \
    && pnpm config set virtual-store-dir /tmp/pnpm-vs --global

# ── 5. 全局 npm 工具（MCP / agent-browser / LSP 相关，装进 mise node@24 prefix）──
# @xybot/cli：xybot 系项目的构建工具链（`xybot dev`/`xybot build`），全局装一份，
# 项目 node_modules 未安装时也能直接调用（项目本地 bin 装好后优先走本地）。
RUN npm install -g supergateway agent-browser bun typescript pyright @xybot/cli \
    && mise reshim \
    && for bin in node npm npx pnpm bun supergateway mise; do \
         ln -sf "/root/.local/share/mise/shims/$bin" "/usr/local/bin/$bin"; \
       done
# 上面 ln 是 bootstrap 重置 PATH 时的兜底：/usr/local/bin 是标准路径，
# symlink 指向 shims 保住版本路由能力（正常 PATH 下 shims 更靠前，不经此）。

# ── 6. Chromium via Playwright（agent-browser 需要）──
RUN npx playwright install --with-deps chromium \
    && ln -sf /root/.cache/ms-playwright/chromium-*/chrome-linux*/chrome /usr/local/bin/chromium
ENV CHROME_PATH=/usr/local/bin/chromium

# ── 7. codegraph（自包含 Node bundle）──
# amd64：用预下载的 tar.gz（docker/opt/codegraph/，gitignore 不入库，缺失时按 README 手动下载）——
#       GitHub releases 在构建环境直连极不稳定（实测 2026-10-12 SSL 断连/超时）。
# arm64：仍走官方 install.sh（raw.githubusercontent.com，网络好时可用）。
# 安装布局与 install.sh 一致：versions/<v>/ + current 软链 + /usr/local/bin 启动链。
ENV CODEGRAPH_VERSION=v1.4.1
ENV CODEGRAPH_INSTALL_DIR=/opt/codegraph
ARG TARGETARCH
COPY docker/opt/codegraph/codegraph-linux-x64.tar.gz /tmp/
RUN if [ "$TARGETARCH" = "amd64" ]; then \
       dest="$CODEGRAPH_INSTALL_DIR/versions/$CODEGRAPH_VERSION" \
       && mkdir -p "$dest" \
       && tar -xzf /tmp/codegraph-linux-x64.tar.gz -C "$dest" --strip-components=1 \
       && mkdir -p "$CODEGRAPH_INSTALL_DIR" \
       && ln -sfn "$dest" "$CODEGRAPH_INSTALL_DIR/current" \
       && ln -sf "$dest/bin/codegraph" /usr/local/bin/codegraph \
       && rm -f /tmp/codegraph-linux-x64.tar.gz; \
     else \
       curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh \
         | CODEGRAPH_BIN_DIR=/usr/local/bin sh; \
     fi \
  && codegraph --version \
  && which codegraph

# ── 8. opencode LSP daemon + TypeScript/pyright ──
COPY docker/opt/opencode-lsp-daemon/ /opt/opencode-lsp-daemon/
RUN chmod +x /opt/opencode-lsp-daemon/index.js \
    && ln -sf /opt/opencode-lsp-daemon/index.js /usr/local/bin/opencode-lsp-agent

# ── 9. 沙箱 session 插件 agent（V2 sandbox 执行）──
COPY docker/opt/sandbox-plugin-agent.ts /opt/sandbox-plugin-agent.ts
COPY docker/opt/sandbox-plugin-npm.ts /opt/sandbox-plugin-npm.ts

# ── 10. 交互式 PTY agent ──
RUN mkdir -p /opt/opencode-pty-agent \
    && cd /opt/opencode-pty-agent \
    && bun add bun-pty@0.4.8
COPY docker/opt/opencode-pty-agent.ts /opt/opencode-pty-agent/index.ts

# ── 11. 常驻 CDP 浏览器（外部控制 9222 + /viewer 实时画面）──
# headless Chromium 常驻（共用第 6 步 Playwright 安装），CDP 经网关透出 0.0.0.0:9222，
# 外部 Playwright/Puppeteer/前端可直连控制；网关内嵌 /viewer 实时画面页。
# 浏览器/网关用 /opt/cdp-browser/cdp-browser.sh start 拉起（幂等），见 docker/README.md。
COPY docker/opt/cdp-browser/cdp-gateway.mjs docker/opt/cdp-browser/viewer.html docker/opt/cdp-browser/cdp-browser.sh /opt/cdp-browser/
RUN chmod +x /opt/cdp-browser/cdp-gateway.mjs /opt/cdp-browser/cdp-browser.sh
ENV CDP_GATEWAY_PORT=9222 \
    CDP_UPSTREAM_PORT=9221 \
    CDP_WINDOW_SIZE=1440,900

# ── 12. 预装依赖缓存（模板项目 → npm cache + /opt/preload + pnpm store）──
# 每个模板两遍：
#   npm  install —— 填充 npm tarball cache（npm_config_cache 已指向 /opt/package-cache-base/npm，
#                   tarball 缓存不依赖 node/pnpm 版本），完整 node_modules 存入 /opt/preload/<name>/
#   pnpm install —— 预热 pnpm store（/opt/pnpm-store，仅 pnpm@10 的 v10 store 格式；
#                   pnpm 8/9/11 各自 store 子目录，命中不了 v10，运行期按需下载）
# 单个模板失败只告警跳过，不阻断构建（缓存为加速项，非功能项）。
COPY docker/packages/ /tmp/preload/packages/
COPY docker/pnpm-workspace.yaml docker/package.json /tmp/preload/
RUN cd /tmp/preload \
    && mkdir -p /opt/preload \
    && for dir in packages/*/; do \
         name=$(basename "$dir"); \
         echo "==> npm preload: $name"; \
         (cd "$dir" && npm install --ignore-scripts --no-audit --no-fund) \
           && cp -a "$dir" "/opt/preload/$name" \
           || echo "WARN: npm preload failed: $name (skipped)"; \
       done \
    && for dir in packages/*/; do \
         echo "==> pnpm store prewarm: $dir"; \
         (cd "$dir" && rm -rf node_modules && pnpm install --ignore-scripts) || true; \
       done \
    && rm -rf /tmp/preload /tmp/pnpm-vs /root/.npm

# ── 13. 瘦身清理（快照提速：commit 全量导出 rootfs）──
# 保留（功能/缓存必需）：/opt/preload、/opt/package-cache-base、/opt/pnpm-store、
#   /root/.local/share/mise（多版本 installs）、/root/.cache/ms-playwright（Chromium）。
# 清理可再生缓存：mise 下载缓存 / pip 缓存 / npm 残留。
RUN rm -rf /root/.cache/mise /root/.cache/pip /root/.npm \
    && rm -rf /usr/local/lib/node_modules/.cache

ENTRYPOINT ["/bin/bash"]
WORKDIR /workspace

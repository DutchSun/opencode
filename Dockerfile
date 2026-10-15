FROM oven/bun:1.3.14-alpine AS base
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories \
    && apk add --no-cache git ripgrep

FROM base AS builder
WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
COPY patches/ patches/
COPY packages packages
RUN rm -rf patches && sed -i '/"patchedDependencies"/,/^[[:space:]]*}/d' package.json
RUN bun install --ignore-scripts

RUN find /app -path "*/node-pty/prebuilds/*/spawn-helper" -exec chmod +x {} \;

FROM base AS runtime
WORKDIR /app

COPY --from=builder /app/node_modules node_modules
COPY --from=builder /app/packages packages
COPY models-dev.json /app/models.json
COPY --from=builder /app/package.json /app/bun.lock /app/bunfig.toml ./

WORKDIR /app/packages/opencode

RUN adduser -D opencode && mkdir -p /workspace && chown opencode:opencode /workspace

COPY opencode.jsonc /home/opencode/.config/opencode/opencode.jsonc
RUN chown -R opencode:opencode /home/opencode

ENV OPENCODE_DEFAULT_DIRECTORY=/workspace
ENV OPENCODE_SERVER_HOSTNAME=0.0.0.0
ENV OPENCODE_SERVER_PORT=4096
ENV OPENCODE_AUTH_PROVIDER=pg
ENV OPENCODE_CCR_ENABLED=true
ENV OPENCODE_SANDBOX_ENABLED=true
ENV OPENCODE_SANDBOX_USE_SERVER_PROXY=true
ENV OPENCODE_SANDBOX_VOLUME_TYPE=pvc
ENV OPENCODE_SANDBOX_PVC_CLAIM=sandbox-test
ENV OPENCODE_SANDBOX_MAX_TTL_SEC=3600
ENV OPENCODE_SANDBOX_IDLE_KILL_SEC=30
ENV OPENCODE_DISABLE_EMBEDDED_WEB_UI=1
ENV OPENCODE_DISABLE_AUTOUPDATE=1
# zen 网关客户端校验要求 UA 带真实版本号（>=1.17.0）——源码直跑无构建期 define 时
# 会 fallback 为 "local" 导致免费模型 403（见 docs/console-free-tier-403-fix.md）
ENV OPENCODE_APP_VERSION=2.0.5
ENV OPENCODE_DATABASE_URL=postgresql://app:8zuhlMLd4gaeUG5k@172.18.32.14:5432/opencode
ENV OPENCODE_SANDBOX_DOMAIN=172.18.32.15:30040
ENV OPENCODE_SANDBOX_API_KEY=H68idVYzjadx
ENV OPENSANDBOX_INSECURE_SERVER=YES

EXPOSE 4096

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://0.0.0.0:${OPENCODE_SERVER_PORT:-4096}/global/health || exit 1

USER opencode

ENTRYPOINT ["bun", "run", "src/index.ts"]
CMD ["serve", "--hostname", "0.0.0.0", "--port", "4096"]

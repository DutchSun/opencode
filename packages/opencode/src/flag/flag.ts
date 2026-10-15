import { Config } from "effect"

function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

function falsy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "false" || value === "0"
}

export namespace Flag {
  export const OTEL_EXPORTER_OTLP_ENDPOINT = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]
  export const OTEL_EXPORTER_OTLP_HEADERS = process.env["OTEL_EXPORTER_OTLP_HEADERS"]

  export const OPENCODE_AUTO_SHARE = truthy("OPENCODE_AUTO_SHARE")
  export const OPENCODE_AUTO_HEAP_SNAPSHOT = truthy("OPENCODE_AUTO_HEAP_SNAPSHOT")
  export const OPENCODE_GIT_BASH_PATH = process.env["OPENCODE_GIT_BASH_PATH"]
  export const OPENCODE_CONFIG = process.env["OPENCODE_CONFIG"]
  export declare const OPENCODE_PURE: boolean
  export declare const OPENCODE_TUI_CONFIG: string | undefined
  export declare const OPENCODE_CONFIG_DIR: string | undefined
  export declare const OPENCODE_PLUGIN_META_FILE: string | undefined
  export const OPENCODE_CONFIG_CONTENT = process.env["OPENCODE_CONFIG_CONTENT"]
  export const OPENCODE_DISABLE_AUTOUPDATE = truthy("OPENCODE_DISABLE_AUTOUPDATE")
  export const OPENCODE_ALWAYS_NOTIFY_UPDATE = truthy("OPENCODE_ALWAYS_NOTIFY_UPDATE")
  export const OPENCODE_DISABLE_PRUNE = truthy("OPENCODE_DISABLE_PRUNE")
  export const OPENCODE_DISABLE_TERMINAL_TITLE = truthy("OPENCODE_DISABLE_TERMINAL_TITLE")
  export const OPENCODE_SHOW_TTFD = truthy("OPENCODE_SHOW_TTFD")
  export const OPENCODE_PERMISSION = process.env["OPENCODE_PERMISSION"]
  export const OPENCODE_DISABLE_DEFAULT_PLUGINS = truthy("OPENCODE_DISABLE_DEFAULT_PLUGINS")
  export const OPENCODE_DISABLE_LSP_DOWNLOAD = truthy("OPENCODE_DISABLE_LSP_DOWNLOAD")
  export const OPENCODE_DISABLE_LSP_TOOL = truthy("OPENCODE_DISABLE_LSP_TOOL")
  export const OPENCODE_ENABLE_EXPERIMENTAL_MODELS = truthy("OPENCODE_ENABLE_EXPERIMENTAL_MODELS")
  export const OPENCODE_DISABLE_AUTOCOMPACT = truthy("OPENCODE_DISABLE_AUTOCOMPACT")
  export const OPENCODE_CCR_ENABLED = truthy("OPENCODE_CCR_ENABLED")
  export const OPENCODE_DISABLE_MODELS_FETCH = truthy("OPENCODE_DISABLE_MODELS_FETCH")
  export const OPENCODE_DISABLE_MOUSE = truthy("OPENCODE_DISABLE_MOUSE")
  export const OPENCODE_DISABLE_CLAUDE_CODE = truthy("OPENCODE_DISABLE_CLAUDE_CODE")
  export const OPENCODE_DISABLE_CLAUDE_CODE_PROMPT =
    OPENCODE_DISABLE_CLAUDE_CODE || truthy("OPENCODE_DISABLE_CLAUDE_CODE_PROMPT")
  export const OPENCODE_DISABLE_CLAUDE_CODE_SKILLS =
    OPENCODE_DISABLE_CLAUDE_CODE || truthy("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS")
  export const OPENCODE_DISABLE_EXTERNAL_SKILLS =
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS || truthy("OPENCODE_DISABLE_EXTERNAL_SKILLS")
  export declare const OPENCODE_DISABLE_PROJECT_CONFIG: boolean
  export const OPENCODE_FAKE_VCS = process.env["OPENCODE_FAKE_VCS"]
  export declare const OPENCODE_CLIENT: string
  export const OPENCODE_SERVER_PASSWORD = process.env["OPENCODE_SERVER_PASSWORD"]
  export const OPENCODE_PTY_TICKET_SECRET = process.env["OPENCODE_PTY_TICKET_SECRET"]
  export const OPENCODE_SERVER_USERNAME = process.env["OPENCODE_SERVER_USERNAME"]
  export const OPENCODE_ENABLE_QUESTION_TOOL = truthy("OPENCODE_ENABLE_QUESTION_TOOL")

  // Experimental
  export const OPENCODE_EXPERIMENTAL = truthy("OPENCODE_EXPERIMENTAL")
  export const OPENCODE_EXPERIMENTAL_FILEWATCHER = Config.boolean("OPENCODE_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  )
  export const OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = Config.boolean(
    "OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER",
  ).pipe(Config.withDefault(false))
  export const OPENCODE_EXPERIMENTAL_ICON_DISCOVERY =
    OPENCODE_EXPERIMENTAL || truthy("OPENCODE_EXPERIMENTAL_ICON_DISCOVERY")

  const copy = process.env["OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
  export const OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT =
    copy === undefined ? process.platform === "win32" : truthy("OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT")
  export const OPENCODE_ENABLE_EXA =
    truthy("OPENCODE_ENABLE_EXA") || OPENCODE_EXPERIMENTAL || truthy("OPENCODE_EXPERIMENTAL_EXA")
  export const OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = number("OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS")
  export const OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX = number("OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX")
  export const OPENCODE_EXPERIMENTAL_OXFMT = OPENCODE_EXPERIMENTAL || truthy("OPENCODE_EXPERIMENTAL_OXFMT")
  export const OPENCODE_EXPERIMENTAL_LSP_TY = truthy("OPENCODE_EXPERIMENTAL_LSP_TY")
  export const OPENCODE_EXPERIMENTAL_LSP_TOOL = OPENCODE_EXPERIMENTAL || truthy("OPENCODE_EXPERIMENTAL_LSP_TOOL")
  export const OPENCODE_DISABLE_FILETIME_CHECK = Config.boolean("OPENCODE_DISABLE_FILETIME_CHECK").pipe(
    Config.withDefault(false),
  )
  export const OPENCODE_EXPERIMENTAL_PLAN_MODE = OPENCODE_EXPERIMENTAL || truthy("OPENCODE_EXPERIMENTAL_PLAN_MODE")
  export const OPENCODE_EXPERIMENTAL_WORKSPACES = OPENCODE_EXPERIMENTAL || truthy("OPENCODE_EXPERIMENTAL_WORKSPACES")
  export const OPENCODE_EXPERIMENTAL_MARKDOWN = !falsy("OPENCODE_EXPERIMENTAL_MARKDOWN")
  export const OPENCODE_MODELS_URL = process.env["OPENCODE_MODELS_URL"]
  export const OPENCODE_MODELS_PATH = process.env["OPENCODE_MODELS_PATH"]
  export const OPENCODE_DISABLE_EMBEDDED_WEB_UI = truthy("OPENCODE_DISABLE_EMBEDDED_WEB_UI")
  export const OPENCODE_DB = process.env["OPENCODE_DB"]
  export const OPENCODE_DATABASE_URL = process.env["OPENCODE_DATABASE_URL"]
  export const OPENCODE_AUTH_PROVIDER = (process.env["OPENCODE_AUTH_PROVIDER"] ?? "auto") as "auto" | "pg" | "file"
  export const OPENCODE_DISABLE_CHANNEL_DB = truthy("OPENCODE_DISABLE_CHANNEL_DB")
  export const OPENCODE_SKIP_MIGRATIONS = truthy("OPENCODE_SKIP_MIGRATIONS")
  export const OPENCODE_STRICT_CONFIG_DEPS = truthy("OPENCODE_STRICT_CONFIG_DEPS")

  export const OPENCODE_DEFAULT_DIRECTORY = process.env["OPENCODE_DEFAULT_DIRECTORY"]
  export const OPENCODE_EVENT_BUS = process.env["OPENCODE_EVENT_BUS"] ?? "local"
  export const OPENCODE_SANDBOX_ENABLED = truthy("OPENCODE_SANDBOX_ENABLED")
  export const OPENCODE_SANDBOX_DOMAIN = process.env["OPENCODE_SANDBOX_DOMAIN"] ?? "localhost:8080"
  // 浏览器等外部客户端可达的 sandbox server 地址（预览代理地址用）；缺省回退 OPENCODE_SANDBOX_DOMAIN
  export const OPENCODE_SANDBOX_PUBLIC_DOMAIN = process.env["OPENCODE_SANDBOX_PUBLIC_DOMAIN"] ?? OPENCODE_SANDBOX_DOMAIN
  export const OPENCODE_SANDBOX_IMAGE =
    process.env["OPENCODE_SANDBOX_IMAGE"] ??
    "crpi-hlpnu8kiweghie0r.cn-hangzhou.personal.cr.aliyuncs.com/shangwfa/opencode-sandbox:mise-preload-v1"
  // snapshot 模式冷启动/降级用的精简镜像（rootfs 小、快照快）；默认（pvc）模式用 OPENCODE_SANDBOX_IMAGE
  export const OPENCODE_SANDBOX_SNAPSHOT_IMAGE =
    process.env["OPENCODE_SANDBOX_SNAPSHOT_IMAGE"] ??
    "crpi-hlpnu8kiweghie0r.cn-hangzhou.personal.cr.aliyuncs.com/shangwfa/opencode-sandbox:mise-preload-v1"
  export const OPENCODE_SANDBOX_TIMEOUT = number("OPENCODE_SANDBOX_TIMEOUT") ?? 600

  export const OPENCODE_SANDBOX_API_KEY = process.env["OPENCODE_SANDBOX_API_KEY"] ?? ""
  export const OPENCODE_SANDBOX_USE_SERVER_PROXY = !falsy("OPENCODE_SANDBOX_USE_SERVER_PROXY")
  // local MCP（沙箱模式）连接是否经 OpenSandbox server 网关代理取 endpoint；缺省 false = 直连沙箱地址
  export const OPENCODE_SANDBOX_MCP_SERVER_PROXY = !falsy("OPENCODE_SANDBOX_MCP_SERVER_PROXY")
  export const OPENCODE_SANDBOX_VOLUME_TYPE = (process.env["OPENCODE_SANDBOX_VOLUME_TYPE"] ?? "pvc") as
    | "none"
    | "pvc"
    | "host"
    | "snapshot"
  export const OPENCODE_SANDBOX_PVC_CLAIM = process.env["OPENCODE_SANDBOX_PVC_CLAIM"] ?? "sandbox-test"
  export const OPENCODE_SANDBOX_SNAPSHOT_TTL_SEC = number("OPENCODE_SANDBOX_SNAPSHOT_TTL_SEC") ?? 14 * 86400
  export const OPENCODE_SANDBOX_SNAPSHOT_WAIT_SEC = number("OPENCODE_SANDBOX_SNAPSHOT_WAIT_SEC") ?? 900
  // 远端快照删除默认关闭（GC TTL / superseded / 会话删除联动均不物理删除），防共享 PG 场景误删
  export const OPENCODE_SANDBOX_SNAPSHOT_DELETE_ENABLED = truthy("OPENCODE_SANDBOX_SNAPSHOT_DELETE_ENABLED")
  // 会话创建即默认保活：root 会话创建后自动 keepalive + boot 沙箱（等价 keep-alive API
  // {"enabled":true,"boot":true}）。设 0/false 关闭（如批量集成测试防沙箱资源暴涨）。
  export const OPENCODE_SESSION_AUTO_KEEPALIVE = !falsy("OPENCODE_SESSION_AUTO_KEEPALIVE")
  export const OPENCODE_SANDBOX_IDLE_KILL_SEC = number("OPENCODE_SANDBOX_IDLE_KILL_SEC") ?? 3600
  export const OPENCODE_SANDBOX_IDLE_REAP_SEC = number("OPENCODE_SANDBOX_IDLE_REAP_SEC") ?? 3600
  export const OPENCODE_SANDBOX_MAX_TTL_SEC = number("OPENCODE_SANDBOX_MAX_TTL_SEC") ?? 3600
  // 沙箱 OOM 采样：周期进沙箱读 cgroup oom_kill 计数做 delta 归因 + 内存水位预警。
  // 注意 number() 不接受 0（>0 校验），禁用请用 OPENCODE_SANDBOX_OOM_SCAN_ENABLED=0
  export const OPENCODE_SANDBOX_OOM_SCAN_ENABLED = !falsy("OPENCODE_SANDBOX_OOM_SCAN_ENABLED")
  export const OPENCODE_SANDBOX_OOM_SCAN_INTERVAL_SEC = number("OPENCODE_SANDBOX_OOM_SCAN_INTERVAL_SEC") ?? 60
  export const OPENCODE_WATCHDOG_TIMEOUT_SEC = number("OPENCODE_WATCHDOG_TIMEOUT_SEC") ?? 120
  export const OPENCODE_WATCHDOG_SCAN_INTERVAL_SEC = number("OPENCODE_WATCHDOG_SCAN_INTERVAL_SEC") ?? 15
  export const OPENCODE_SESSION_STALE_RUN_SEC = number("OPENCODE_SESSION_STALE_RUN_SEC") ?? 1800
  export const OPENCODE_SESSION_LOCK_TIMEOUT_SEC = number("OPENCODE_SESSION_LOCK_TIMEOUT_SEC") ?? 60
  export const OPENCODE_HITL_MAX_PENDING_PER_SESSION = number("OPENCODE_HITL_MAX_PENDING_PER_SESSION") ?? 10
  export const OPENCODE_PG_STATEMENT_TIMEOUT_MS = number("OPENCODE_PG_STATEMENT_TIMEOUT_MS") ?? 30000
  // Abandoned transactions stuck in `idle in transaction` (crashed/hung run) keep
  // their advisory/row locks forever, blocking the watchdog's markTimedOut and any
  // later run needing the same advisory key. PG auto-terminates such sessions after
  // this duration, releasing the locks.
  export const OPENCODE_PG_IDLE_TX_TIMEOUT_MS = number("OPENCODE_PG_IDLE_TX_TIMEOUT_MS") ?? 60000
  export const OPENCODE_SANDBOX_PACKAGE_CACHE_MOUNT =
    process.env["OPENCODE_SANDBOX_PACKAGE_CACHE_MOUNT"] ?? "/opt/pnpm-store"
  // 快照前清理可重建产物（/tmp、各类 cache），减小快照体积；默认关，避免牺牲恢复后 node_modules 即用性
  export const OPENCODE_SANDBOX_SNAPSHOT_PRUNE = truthy("OPENCODE_SANDBOX_SNAPSHOT_PRUNE")
  // 周期性快照保鲜：快照模式会话空闲超过间隔即刷新快照（不销毁源沙箱）。平台 TTL 硬回收
  // 绕过 SaaS 销毁路径时无法做临终快照，该间隔即数据丢失窗口上限（RPO）。设 0/false 关闭。
  export const OPENCODE_SANDBOX_SNAPSHOT_PERIODIC_ENABLED = !falsy("OPENCODE_SANDBOX_SNAPSHOT_PERIODIC_ENABLED")
  export const OPENCODE_SANDBOX_SNAPSHOT_INTERVAL_SEC = number("OPENCODE_SANDBOX_SNAPSHOT_INTERVAL_SEC") ?? 1800

  function number(key: string) {
    const value = process.env[key]
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }
}

// Dynamic getter for OPENCODE_DISABLE_PROJECT_CONFIG
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "OPENCODE_DISABLE_PROJECT_CONFIG", {
  get() {
    return truthy("OPENCODE_DISABLE_PROJECT_CONFIG")
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for OPENCODE_TUI_CONFIG
// This must be evaluated at access time, not module load time,
// because tests and external tooling may set this env var at runtime
Object.defineProperty(Flag, "OPENCODE_TUI_CONFIG", {
  get() {
    return process.env["OPENCODE_TUI_CONFIG"]
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for OPENCODE_CONFIG_DIR
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "OPENCODE_CONFIG_DIR", {
  get() {
    return process.env["OPENCODE_CONFIG_DIR"]
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for OPENCODE_PURE
// This must be evaluated at access time, not module load time,
// because the CLI can set this flag at runtime
Object.defineProperty(Flag, "OPENCODE_PURE", {
  get() {
    return truthy("OPENCODE_PURE")
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for OPENCODE_PLUGIN_META_FILE
// This must be evaluated at access time, not module load time,
// because tests and external tooling may set this env var at runtime
Object.defineProperty(Flag, "OPENCODE_PLUGIN_META_FILE", {
  get() {
    return process.env["OPENCODE_PLUGIN_META_FILE"]
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for OPENCODE_CLIENT
// This must be evaluated at access time, not module load time,
// because some commands override the client at runtime
Object.defineProperty(Flag, "OPENCODE_CLIENT", {
  get() {
    return process.env["OPENCODE_CLIENT"] ?? "cli"
  },
  enumerable: true,
  configurable: false,
})

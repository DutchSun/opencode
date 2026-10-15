import { ProviderAuth } from "@/provider/auth"
import { Config } from "@/config/config"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Provider } from "@/provider/provider"
import { Auth } from "@/auth"
import { getRequestUserId } from "@/auth/request-user"

import { mapValues } from "remeda"
import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ProviderAuthApiError } from "../groups/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"

function mapProviderAuthError<A, R>(self: Effect.Effect<A, ProviderAuth.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => {
      if (error instanceof ProviderAuth.OauthMissing) {
        return new ProviderAuthApiError({ name: error._tag, data: { providerID: error.providerID } })
      }
      if (error instanceof ProviderAuth.OauthCodeMissing) {
        return new ProviderAuthApiError({ name: error._tag, data: { providerID: error.providerID } })
      }
      if (error instanceof ProviderAuth.OauthCallbackFailed) {
        return new ProviderAuthApiError({ name: error._tag, data: {} })
      }
      if (error instanceof ProviderAuth.ValidationFailed) {
        return new ProviderAuthApiError({ name: error._tag, data: { field: error.field, message: error.message } })
      }
      return new ProviderAuthApiError({ name: "BadRequest", data: {} })
    }),
  )
}

export const providerHandlers = HttpApiBuilder.group(InstanceHttpApi, "provider", (handlers) =>
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const provider = yield* Provider.Service
    const svc = yield* ProviderAuth.Service
    const authStore = yield* Auth.Service

    const list = Effect.fn("ProviderHttpApi.list")(function* (ctx: {
      query?: { scope?: "visible" | "connect" }
    }) {
      const config = yield* cfg.get()
      const all = yield* ModelsDev.Service.use((s) => s.get())
      const disabled = new Set(config.disabled_providers ?? [])
      const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined
      const filtered: Record<string, (typeof all)[string]> = {}
      for (const [key, value] of Object.entries(all)) {
        if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) filtered[key] = value
      }
      const request = yield* HttpServerRequest.HttpServerRequest
      const userId = getRequestUserId(request.headers)
      const connected = yield* provider.list()
      const credentials = yield* authStore.all(userId).pipe(Effect.orDie)
      // Runtime providers built from auth credentials (source "api" from API
      // keys, "custom" from oauth loaders) must disappear once the credential
      // is removed — the runtime state is cached per instance, but the
      // response must reflect the auth store on every request. Providers from
      // env/config stay regardless of the auth table.
      const providers: Record<string, Provider.Info> = {}
      for (const [id, info] of Object.entries(connected)) {
        if ((info.source === "api" || info.source === "custom") && !credentials[id]) continue
        providers[id] = info
      }
      for (const [id, cred] of Object.entries(credentials)) {
        if (providers[id]) continue
        const catalogItem = filtered[id]
        if (!catalogItem) continue
        providers[id] = {
          ...Provider.fromModelsDevProvider(catalogItem),
          source: cred.type === "api" ? "api" : "custom",
        }
      }
      if (ctx?.query?.scope === "visible") {
        // Per-identity usable-only view for compact pickers; the default
        // response keeps `all` as the full enabled catalog (legacy semantics)
        // with `connected` marking what this identity can use.
        return {
          all: Object.values(providers).map(Provider.toPublicInfo),
          default: Provider.defaultModelIDs(providers),
          connected: Object.keys(providers),
        }
      }
      // Default and connect views: full enabled catalog with runtime state
      // layered on top; `connected` marks what this identity can use.
      const merged = {
        ...mapValues(filtered, (item) => Provider.fromModelsDevProvider(item)),
        ...providers,
      }
      return {
        all: Object.values(merged).map(Provider.toPublicInfo),
        default: Provider.defaultModelIDs(merged),
        connected: Object.keys(providers),
      }
    })

    const auth = Effect.fn("ProviderHttpApi.auth")(function* () {
      return yield* svc.methods()
    })

    const authorize = Effect.fn("ProviderHttpApi.authorize")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProviderAuth.AuthorizeInput
      userId?: string
    }) {
      return yield* mapProviderAuthError(
        svc.authorize({
          providerID: ctx.params.providerID,
          method: ctx.payload.method,
          inputs: ctx.payload.inputs,
          userId: ctx.userId,
        }),
      )
    })

    const authorizeRaw = Effect.fn("ProviderHttpApi.authorizeRaw")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ProviderAuth.AuthorizeInput))(body).pipe(
        Effect.mapError(() => new ProviderAuthApiError({ name: "BadRequest", data: {} })),
      )
      // Match legacy route behavior: when authorize() resolves without a
      // result (e.g. no further redirect), serialize as JSON `null` instead
      // of an empty body so clients can `.json()` parse the response.
      const result = yield* authorize({
        params: ctx.params,
        payload,
        userId: getRequestUserId(ctx.request.headers),
      })
      return HttpServerResponse.jsonUnsafe(result ?? null)
    })

    const callback = Effect.fn("ProviderHttpApi.callback")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProviderAuth.CallbackInput
    }) {
      const request = yield* HttpServerRequest.HttpServerRequest
      yield* mapProviderAuthError(
        svc.callback({
          providerID: ctx.params.providerID,
          method: ctx.payload.method,
          code: ctx.payload.code,
          userId: getRequestUserId(request.headers),
        }),
      )
      return true
    })

    return handlers
      .handle("list", list)
      .handle("auth", auth)
      .handleRaw("authorize", authorizeRaw)
      .handle("callback", callback)
  }),
)

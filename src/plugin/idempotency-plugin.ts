import { Elysia } from 'elysia'
import { IdempotencyKey } from '../core/idempotency-key'
import type { IdempotencyLease } from '../engine/begin-outcome'
import { parseOptions } from '../engine/engine-schema'
import { IdempotencyEngine } from '../engine/idempotency-engine'
import { IdempotencyError, StoreUnavailableError } from '../errors'
import { RequestFingerprint } from '../fingerprint/request-fingerprint'
import { ClientIpResolver } from '../keys/client-ip-resolver'
import { HeaderFilter } from '../records/header-filter'
import { ResponseSnapshot, type StoredResponse } from '../records/stored-response'
import {
  type IdempotencyElysiaContext,
  type IdempotencyPluginOptions,
  type IdempotencyPluginSettings,
  type IdempotencyRequestContext,
  idempotencyPluginOptionsSchema,
} from './plugin-schema'
import { type IdempotencyRejection, REJECTIONS, RejectionResponse } from './rejection-response'
import { ResponseCapture } from './response-capture'
import { StoragePolicy } from './storage-policy'

export type IdempotencyOutcome =
  | { readonly status: 'skipped' }
  | { readonly status: 'started'; readonly key: string }
  | { readonly status: 'replayed' }
  | { readonly status: 'rejected'; readonly rejection: IdempotencyRejection }
  | { readonly status: 'unavailable'; readonly error: IdempotencyError }

interface Checked {
  readonly outcome: IdempotencyOutcome
  readonly lease?: IdempotencyLease
  readonly replay?: StoredResponse
}

interface RequestState {
  readonly fingerprint?: Promise<string>
  readonly stopFingerprint?: AbortController
  readonly context?: IdempotencyRequestContext
  readonly checked?: Checked
}

interface FinishContext {
  readonly request: Request
  readonly set: IdempotencyElysiaContext['set']
  readonly responseValue: unknown
}

const SKIPPED: Checked = { outcome: { status: 'skipped' } }

const rejected = (rejection: IdempotencyRejection): Checked => ({ outcome: { status: 'rejected', rejection } })

let pluginInstances = 0

class IdempotencyGuard {
  private readonly engine: IdempotencyEngine
  private readonly resolver: ClientIpResolver
  private readonly rejections: RejectionResponse
  private readonly capture: ResponseCapture
  private readonly policy: StoragePolicy
  private readonly states = new WeakMap<Request, RequestState>()

  constructor(private readonly settings: IdempotencyPluginSettings) {
    const { store, prefix, retentionMs, lockTimeoutMs, clock } = settings
    this.engine = new IdempotencyEngine({ store, prefix, retention: retentionMs, lockTimeout: lockTimeoutMs, clock })
    this.resolver = new ClientIpResolver(settings.trustProxy)
    this.rejections = new RejectionResponse(settings.onRejected)
    this.capture = new ResponseCapture(settings.maxBodyBytes, new HeaderFilter(settings.excludeHeaders))
    this.policy = new StoragePolicy(settings.shouldStore)
  }

  prepare(request: Request): void {
    if (this.settings.fingerprint !== true || !this.covers(request)) return
    if (IdempotencyKey.parse(request.headers.get(this.settings.header)).status !== 'valid') return
    const stopFingerprint = new AbortController()
    const fingerprint = RequestFingerprint.compute(request, stopFingerprint.signal)
    fingerprint.catch(() => undefined)
    this.states.set(request, { fingerprint, stopFingerprint })
  }

  discard(request: Request): void {
    this.states.get(request)?.stopFingerprint?.abort()
  }

  async check(elysia: IdempotencyElysiaContext): Promise<IdempotencyOutcome> {
    const context = this.requestContext(elysia)
    const checked = await this.evaluate(context)
    this.states.set(elysia.request, { ...this.states.get(elysia.request), context, checked })
    return checked.outcome
  }

  async respond(elysia: IdempotencyElysiaContext): Promise<unknown> {
    const state = this.states.get(elysia.request)
    const checked = state?.checked
    if (state?.context === undefined || checked === undefined) return undefined
    if (checked.replay !== undefined) return ResponseSnapshot.toResponse(checked.replay)
    const rejection = this.rejectionFor(checked.outcome)
    return rejection === null ? undefined : this.rejections.respond(state.context, rejection)
  }

  async finish({ request, set, responseValue }: FinishContext): Promise<Response | undefined> {
    const lease = this.takeLease(request)
    if (lease === undefined) return undefined
    try {
      const response = await this.capture.toResponse(responseValue, set, request)
      await this.settle(lease, response)
      return response
    } catch (error) {
      await this.releaseQuietly(lease)
      throw error
    }
  }

  async abandon(request: Request): Promise<void> {
    const lease = this.takeLease(request)
    if (lease !== undefined) await this.releaseQuietly(lease)
  }

  close(): Promise<void> {
    return this.engine.close()
  }

  private covers(request: Request): boolean {
    return this.settings.methods.has(request.method.toUpperCase())
  }

  private requestContext(elysia: IdempotencyElysiaContext): IdempotencyRequestContext {
    const address = this.resolver.resolve(elysia.request, elysia.server)
    const ip = address === null ? null : address.toKey(this.settings.ipv6Subnet)
    return { request: elysia.request, path: elysia.path, ip, elysia }
  }

  private async evaluate(context: IdempotencyRequestContext): Promise<Checked> {
    if (!this.covers(context.request)) return SKIPPED
    const key = IdempotencyKey.parse(context.request.headers.get(this.settings.header))
    if (key.status === 'invalid') return rejected(REJECTIONS.invalidKey)
    if (key.status === 'missing') return this.settings.required ? rejected(REJECTIONS.missingKey) : SKIPPED
    const fingerprint = await this.fingerprintFor(context)
    const scope = await this.identityFor(context)
    return this.begin(scope, key.value, fingerprint)
  }

  private async begin(scope: string, key: string, fingerprint: string | null): Promise<Checked> {
    try {
      const outcome = await this.engine.begin({ scope, key, fingerprint })
      if (outcome.kind === 'started') return { outcome: { status: 'started', key }, lease: outcome.lease }
      if (outcome.kind === 'replay') return { outcome: { status: 'replayed' }, replay: outcome.response }
      return rejected(outcome.kind === 'in-progress' ? REJECTIONS.inProgress : REJECTIONS.mismatch)
    } catch (error) {
      return { outcome: { status: 'unavailable', error: IdempotencyGuard.toIdempotencyError(error) } }
    }
  }

  private async fingerprintFor(context: IdempotencyRequestContext): Promise<string | null> {
    const { fingerprint } = this.settings
    if (fingerprint === false) return null
    if (fingerprint === true) return this.states.get(context.request)?.fingerprint ?? RequestFingerprint.compute(context.request)
    const value: unknown = await fingerprint(context)
    if (typeof value !== 'string') throw new TypeError('Idempotency fingerprint function must return a string')
    return Bun.CryptoHasher.hash('sha256', value, 'hex')
  }

  private async identityFor(context: IdempotencyRequestContext): Promise<string> {
    const identity: unknown = await this.settings.identity(context)
    if (typeof identity !== 'string') throw new TypeError('Idempotency identity function must return a string')
    return identity
  }

  private rejectionFor(outcome: IdempotencyOutcome): IdempotencyRejection | null {
    if (outcome.status === 'rejected') return outcome.rejection
    if (outcome.status === 'unavailable' && this.settings.failureMode === 'closed') return REJECTIONS.unavailable
    return null
  }

  private takeLease(request: Request): IdempotencyLease | undefined {
    const state = this.states.get(request)
    const checked = state?.checked
    if (checked?.lease === undefined) return undefined
    this.states.set(request, { ...state, checked: { outcome: checked.outcome } })
    return checked.lease
  }

  private async settle(lease: IdempotencyLease, response: Response): Promise<void> {
    if (!this.policy.allows(response.status)) return this.releaseQuietly(lease)
    try {
      await this.engine.complete(lease, await this.capture.snapshot(response))
    } catch {
      await this.releaseQuietly(lease)
    }
  }

  private async releaseQuietly(lease: IdempotencyLease): Promise<void> {
    await this.engine.release(lease).catch(() => false)
  }

  private static toIdempotencyError(error: unknown): IdempotencyError {
    if (error instanceof IdempotencyError) return error
    return new StoreUnavailableError('Idempotency store is unavailable', { cause: error })
  }
}

export const idempotency = (options: IdempotencyPluginOptions = {}) => {
  const settings = parseOptions(idempotencyPluginOptionsSchema, options)
  const guard = new IdempotencyGuard(settings)
  const scope = { as: settings.scope as 'scoped' }
  pluginInstances += 1
  return new Elysia({ name: 'elysia-idempotency', seed: pluginInstances })
    .onRequest(({ request }) => guard.prepare(request))
    .resolve(scope, async (context) => ({ idempotency: await guard.check(context) }))
    .onBeforeHandle(scope, async (context) => guard.respond(context))
    .mapResponse(scope, async (context) => guard.finish(context))
    .onError(scope, async ({ request }) => guard.abandon(request))
    .onError({ as: 'global' }, ({ request }) => guard.discard(request))
    .onAfterResponse(scope, async ({ request }) => guard.abandon(request))
    .onAfterResponse({ as: 'global' }, ({ request }) => guard.discard(request))
    .onStop(async () => guard.close())
}

export type IdempotencyPlugin = ReturnType<typeof idempotency>

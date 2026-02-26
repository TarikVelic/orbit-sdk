const SDK_NAME = "shopcircle-orbit"
const SDK_VERSION = "1.0.2"

// ─── Constants ─────────────────────────────────────────────────────────────────

const FLUSH_INTERVAL_MS = 2000
const MAX_BATCH_SIZE = 10
const MAX_QUEUE_SIZE = 1000
const MAX_RETRIES = 3
const BASE_RETRY_DELAY_MS = 1000
const REQUEST_TIMEOUT_MS = 10000

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OrbitOptions {
  /** Your client ID from the analytics dashboard */
  clientId: string
  /** Base URL of your analytics panel (e.g. "https://analytics.yoursite.com") */
  apiUrl?: string
  /** Automatically track page/screen views (default: true) */
  trackScreenViews?: boolean
  /** Automatically track clicks on outgoing links (default: false) */
  trackOutgoingLinks?: boolean
  /** Automatically track data-orbit-* attributes on clicked elements (default: false) */
  trackAttributes?: boolean
}

export interface IdentifyTraits {
  firstName?: string
  lastName?: string
  email?: string
  avatar?: string
  [key: string]: unknown
}

export type Properties = Record<string, unknown>

interface EventPayload {
  type: string
  payload: Record<string, unknown>
}

// ─── SDK ──────────────────────────────────────────────────────────────────────

export class ShopCircleOrbit {
  private clientId: string
  private apiUrl: string
  private trackScreenViews: boolean
  private trackOutgoingLinks: boolean
  private trackAttributes: boolean
  private profileId: string | null = null
  private destroyed = false

  // Batching state
  private pendingEvents: EventPayload[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  // Stored references for cleanup
  private popstateHandler: (() => void) | null = null
  private clickHandler: ((e: MouseEvent) => void) | null = null
  private beforeUnloadHandler: (() => void) | null = null
  private lastPath: string | null = null
  private originalPushState: typeof history.pushState | null = null
  private originalReplaceState: typeof history.replaceState | null = null

  constructor(options: OrbitOptions) {
    this.clientId = options.clientId
    this.apiUrl = (options.apiUrl || "").replace(/\/$/, "")
    this.trackScreenViews = options.trackScreenViews ?? true
    this.trackOutgoingLinks = options.trackOutgoingLinks ?? false
    this.trackAttributes = options.trackAttributes ?? false

    if (!this.clientId) {
      console.warn("[shopcircle-orbit] Missing clientId")
      return
    }

    if (typeof window !== "undefined") {
      this.setupAutoTracking()
      this.setupBeforeUnload()
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────

  /**
   * Track a custom event with optional properties.
   *
   * @example
   * orbit.track("button_clicked", { label: "Sign Up", variant: "primary" })
   */
  track(name: string, properties?: Properties): void {
    this.addEvent({
      type: "track",
      payload: {
        name,
        properties: {
          ...this.getPageContext(),
          ...properties,
        },
      },
    })
  }

  /**
   * Identify a user. Subsequent events will be associated with this profile.
   *
   * @example
   * orbit.identify("user_123", { firstName: "John", email: "john@example.com" })
   */
  identify(profileId: string, traits?: IdentifyTraits): void {
    this.profileId = profileId

    const { firstName, lastName, email, avatar, ...rest } = traits || {}

    this.addEvent({
      type: "identify",
      payload: {
        profileId,
        firstName,
        lastName,
        email,
        avatar,
        properties: Object.keys(rest).length > 0 ? rest : undefined,
      },
    })
  }

  /**
   * Reset the current user identity (e.g. on logout).
   */
  reset(): void {
    this.profileId = null
  }

  /**
   * Clean up event listeners and flush remaining events.
   * Call this when unmounting in SPA frameworks.
   */
  destroy(): void {
    this.destroyed = true

    // Flush any remaining events before tearing down
    this.flushBatch()

    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    if (typeof window === "undefined") return

    if (this.popstateHandler) {
      window.removeEventListener("popstate", this.popstateHandler)
    }
    if (this.clickHandler) {
      document.removeEventListener("click", this.clickHandler, true)
    }
    if (this.beforeUnloadHandler) {
      window.removeEventListener("beforeunload", this.beforeUnloadHandler)
    }
    if (this.originalPushState) {
      history.pushState = this.originalPushState
    }
    if (this.originalReplaceState) {
      history.replaceState = this.originalReplaceState
    }
  }

  // ─── Auto-tracking ────────────────────────────────────────────────────

  private setupAutoTracking(): void {
    if (this.trackScreenViews) {
      this.trackScreenView()
      this.observeNavigation()
    }

    if (this.trackOutgoingLinks || this.trackAttributes) {
      this.observeClicks()
    }
  }

  private trackScreenView(): void {
    const path = window.location.pathname + window.location.search
    if (path === this.lastPath) return
    this.lastPath = path

    this.track("screen_view", {
      path: window.location.pathname,
      origin: window.location.origin,
      referrer: document.referrer || undefined,
      referrer_name: document.referrer
        ? this.extractDomain(document.referrer)
        : undefined,
      title: document.title || undefined,
    })
  }

  private observeNavigation(): void {
    this.popstateHandler = () => this.trackScreenView()
    window.addEventListener("popstate", this.popstateHandler)

    this.originalPushState = history.pushState.bind(history)
    this.originalReplaceState = history.replaceState.bind(history)

    history.pushState = (...args) => {
      this.originalPushState!(...args)
      setTimeout(() => this.trackScreenView(), 0)
    }

    history.replaceState = (...args) => {
      this.originalReplaceState!(...args)
      setTimeout(() => this.trackScreenView(), 0)
    }
  }

  private observeClicks(): void {
    this.clickHandler = (e: MouseEvent) => {
      const target = (e.target as Element)?.closest?.("a, [data-orbit-event]")
      if (!target) return

      if (this.trackOutgoingLinks && target.tagName === "A") {
        const href = (target as HTMLAnchorElement).href
        if (href && this.isExternalLink(href)) {
          this.track("outgoing_link", {
            href,
            text: (target.textContent || "").trim().substring(0, 200),
          })
        }
      }

      if (this.trackAttributes) {
        const eventName = target.getAttribute("data-orbit-event")
        if (eventName) {
          const props: Properties = {}
          for (const attr of Array.from(target.attributes)) {
            if (attr.name.startsWith("data-orbit-") && attr.name !== "data-orbit-event") {
              const key = attr.name.replace("data-orbit-", "")
              props[key] = attr.value
            }
          }
          this.track(eventName, props)
        }
      }
    }
    document.addEventListener("click", this.clickHandler, true)
  }

  // ─── beforeunload ──────────────────────────────────────────────────────

  private setupBeforeUnload(): void {
    this.beforeUnloadHandler = () => {
      if (this.pendingEvents.length === 0) return

      const events = this.drainPendingEvents()
      const body = JSON.stringify({
        events,
        clientId: this.clientId,
        sdkName: SDK_NAME,
        sdkVersion: SDK_VERSION,
      })

      const url = `${this.apiUrl}/api/track/batch`

      if (typeof navigator !== "undefined" && navigator.sendBeacon) {
        const blob = new Blob([body], { type: "application/json" })
        navigator.sendBeacon(url, blob)
      }
    }
    window.addEventListener("beforeunload", this.beforeUnloadHandler)
  }

  // ─── Batching & Network ─────────────────────────────────────────────────

  private addEvent(event: EventPayload): void {
    if (this.destroyed) return

    if (this.profileId && !event.payload.profileId) {
      event.payload.profileId = this.profileId
    }

    if (this.pendingEvents.length >= MAX_QUEUE_SIZE) {
      const overflow = this.pendingEvents.length - MAX_QUEUE_SIZE + 1
      this.pendingEvents.splice(0, overflow)
    }

    this.pendingEvents.push(event)

    if (this.pendingEvents.length >= MAX_BATCH_SIZE) {
      this.flushBatch()
    } else {
      this.scheduleFlush()
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushBatch()
    }, FLUSH_INTERVAL_MS)
  }

  private drainPendingEvents(): EventPayload[] {
    const events = this.pendingEvents
    this.pendingEvents = []
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    return events
  }

  private flushBatch(): void {
    const events = this.drainPendingEvents()
    if (events.length === 0) return

    if (events.length === 1) {
      this.sendWithRetry(`${this.apiUrl}/api/track`, events[0])
      return
    }

    this.sendWithRetry(`${this.apiUrl}/api/track/batch`, { events })
  }

  private async sendWithRetry(
    url: string,
    body: unknown,
    attempt = 0
  ): Promise<void> {
    if (this.destroyed && attempt > 0) return

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "shopcircle-client-id": this.clientId,
          "shopcircle-sdk-name": SDK_NAME,
          "shopcircle-sdk-version": SDK_VERSION,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        keepalive: true,
      })

      clearTimeout(timeoutId)

      if (response.status >= 400 && response.status < 500) return

      if (response.status >= 500 && attempt < MAX_RETRIES) {
        await this.delay(BASE_RETRY_DELAY_MS * Math.pow(2, attempt))
        return this.sendWithRetry(url, body, attempt + 1)
      }
    } catch {
      clearTimeout(timeoutId)
      if (attempt < MAX_RETRIES) {
        await this.delay(BASE_RETRY_DELAY_MS * Math.pow(2, attempt))
        return this.sendWithRetry(url, body, attempt + 1)
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private getPageContext(): Properties {
    if (typeof window === "undefined") return {}
    return {
      path: window.location.pathname,
      origin: window.location.origin,
    }
  }

  private isExternalLink(href: string): boolean {
    try {
      return new URL(href).origin !== window.location.origin
    } catch {
      return false
    }
  }

  private extractDomain(url: string): string {
    try {
      return new URL(url).hostname
    } catch {
      return url
    }
  }
}

// ─── Convenience factory ──────────────────────────────────────────────────────

/**
 * Create a new ShopCircleOrbit instance.
 *
 * @example
 * import { createOrbit } from "shopcircle-orbit"
 *
 * const orbit = createOrbit({
 *   clientId: "your-client-id",
 *   apiUrl: "https://analytics.yoursite.com",
 * })
 *
 * orbit.track("purchase", { amount: 99.99 })
 */
export function createOrbit(options: OrbitOptions): ShopCircleOrbit {
  return new ShopCircleOrbit(options)
}

// Default export for convenience
export default ShopCircleOrbit

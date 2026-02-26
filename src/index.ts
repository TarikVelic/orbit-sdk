const SDK_NAME = "shopcircle-orbit"
const SDK_VERSION = "1.0.0"

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

// ─── SDK ──────────────────────────────────────────────────────────────────────

export class ShopCircleOrbit {
  private clientId: string
  private apiUrl: string
  private trackScreenViews: boolean
  private trackOutgoingLinks: boolean
  private trackAttributes: boolean
  private profileId: string | null = null
  private queue: Array<() => Promise<void>> = []
  private flushing = false
  private destroyed = false

  // Stored references for cleanup
  private popstateHandler: (() => void) | null = null
  private clickHandler: ((e: MouseEvent) => void) | null = null
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
    this.enqueue(() =>
      this.send({
        type: "track",
        payload: {
          name,
          properties: {
            ...this.getPageContext(),
            ...properties,
          },
        },
      })
    )
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

    this.enqueue(() =>
      this.send({
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
    )
  }

  /**
   * Reset the current user identity (e.g. on logout).
   */
  reset(): void {
    this.profileId = null
  }

  /**
   * Clean up event listeners. Call this when unmounting in SPA frameworks.
   */
  destroy(): void {
    this.destroyed = true
    if (typeof window === "undefined") return

    if (this.popstateHandler) {
      window.removeEventListener("popstate", this.popstateHandler)
    }
    if (this.clickHandler) {
      document.removeEventListener("click", this.clickHandler, true)
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
    // Listen for popstate (back/forward)
    this.popstateHandler = () => this.trackScreenView()
    window.addEventListener("popstate", this.popstateHandler)

    // Monkey-patch pushState/replaceState to detect SPA navigations
    this.originalPushState = history.pushState.bind(history)
    this.originalReplaceState = history.replaceState.bind(history)

    history.pushState = (...args) => {
      this.originalPushState!(...args)
      // Small delay to let the URL update
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

      // Track outgoing links
      if (this.trackOutgoingLinks && target.tagName === "A") {
        const href = (target as HTMLAnchorElement).href
        if (href && this.isExternalLink(href)) {
          this.track("outgoing_link", {
            href,
            text: (target.textContent || "").trim().substring(0, 200),
          })
        }
      }

      // Track data-orbit-* attributes
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

  // ─── Network ──────────────────────────────────────────────────────────

  private async send(body: {
    type: string
    payload: Record<string, unknown>
  }): Promise<void> {
    if (this.destroyed) return

    // Inject profileId if set
    if (this.profileId && !body.payload.profileId) {
      body.payload.profileId = this.profileId
    }

    const url = `${this.apiUrl}/api/track`

    try {
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "shopcircle-client-id": this.clientId,
          "shopcircle-sdk-name": SDK_NAME,
          "shopcircle-sdk-version": SDK_VERSION,
        },
        body: JSON.stringify(body),
        keepalive: true,
      })
    } catch {
      // Silently fail - analytics should never break the app
    }
  }

  // ─── Queue ────────────────────────────────────────────────────────────

  private enqueue(fn: () => Promise<void>): void {
    this.queue.push(fn)
    this.flush()
  }

  private async flush(): Promise<void> {
    if (this.flushing) return
    this.flushing = true

    while (this.queue.length > 0) {
      const fn = this.queue.shift()!
      await fn()
    }

    this.flushing = false
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

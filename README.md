# shopcircle-orbit

Lightweight analytics SDK for [ShopCircle Orbit](https://github.com/shopcircle/orbit). Track events, identify users, and measure engagement with zero dependencies.

## Install

```bash
npm install shopcircle-orbit
```

## Quick Start

```typescript
import { ShopCircleOrbit } from 'shopcircle-orbit';

const orbit = new ShopCircleOrbit({
  clientId: 'your-client-id',
  apiUrl: 'https://analytics.yoursite.com',
  trackScreenViews: true,
  trackOutgoingLinks: true,
  trackAttributes: true,
});

// Track a custom event
orbit.track('button_clicked', { label: 'Sign Up', variant: 'primary' });

// Identify a user
orbit.identify('user_123', {
  firstName: 'John',
  email: 'john@example.com',
});

// Reset identity (e.g. on logout)
orbit.reset();
```

## Script Tag

No build step required:

```html
<script type="module">
  import { ShopCircleOrbit } from 'https://esm.sh/shopcircle-orbit';

  const orbit = new ShopCircleOrbit({
    clientId: 'your-client-id',
    apiUrl: 'https://analytics.yoursite.com',
    trackScreenViews: true,
  });

  window.orbit = orbit;
</script>
```

## React / Next.js

```tsx
import { ShopCircleOrbit } from 'shopcircle-orbit';
import { createContext, useContext, useRef } from 'react';

const OrbitContext = createContext<ShopCircleOrbit | null>(null);

export function OrbitProvider({ children }: { children: React.ReactNode }) {
  const orbitRef = useRef(
    new ShopCircleOrbit({
      clientId: 'your-client-id',
      apiUrl: 'https://analytics.yoursite.com',
      trackScreenViews: true,
      trackOutgoingLinks: true,
    })
  );

  return (
    <OrbitContext.Provider value={orbitRef.current}>
      {children}
    </OrbitContext.Provider>
  );
}

export const useOrbit = () => {
  const ctx = useContext(OrbitContext);
  if (!ctx) throw new Error('Wrap your app with <OrbitProvider>');
  return ctx;
};
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `clientId` | `string` | *required* | Your client ID from the Orbit dashboard |
| `apiUrl` | `string` | `""` | Base URL of your Orbit instance |
| `trackScreenViews` | `boolean` | `true` | Auto-track page views and SPA navigations |
| `trackOutgoingLinks` | `boolean` | `false` | Auto-track clicks on external links |
| `trackAttributes` | `boolean` | `false` | Auto-track elements with `data-orbit-*` attributes |

## Data Attributes

Track events declaratively with HTML attributes:

```html
<button data-orbit-event="cta_clicked" data-orbit-variant="hero" data-orbit-plan="pro">
  Get Started
</button>
```

## API

| Method | Description |
|---|---|
| `track(name, properties?)` | Track a custom event |
| `identify(profileId, traits?)` | Identify a user |
| `reset()` | Clear current user identity |
| `destroy()` | Remove all event listeners |

## License

MIT

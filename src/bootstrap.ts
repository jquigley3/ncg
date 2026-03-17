import { createRoute, getRouteByName } from './routes.js';
import { grantPermission } from './permissions.js';
import { createInjector, getInjectorByName } from './injectors.js';

const ANTHROPIC_ROUTE_NAME = 'anthropic';
const ANTHROPIC_INJECTOR_NAME = 'anthropic-default';

/**
 * Ensures the default Anthropic reverse route and injector exist.
 * Creates them on first run using ANTHROPIC_API_KEY from env.
 */
export function ensureDefaultRoutes(): void {
  let route = getRouteByName(ANTHROPIC_ROUTE_NAME);
  const apiKey = process.env.ANTHROPIC_API_KEY || 'placeholder';

  if (!route) {
    if (apiKey === 'placeholder') {
      console.warn(
        'ANTHROPIC_API_KEY not set; anthropic route created with placeholder. Set env to enable Claude API.'
      );
    }

    createRoute({
      name: ANTHROPIC_ROUTE_NAME,
      type: 'reverse',
      path_prefix: '/anthropic',
      upstream_url: 'https://api.anthropic.com',
      description: 'Anthropic API (auto-created)',
    });
    route = getRouteByName(ANTHROPIC_ROUTE_NAME)!;
    console.log(`Route "${ANTHROPIC_ROUTE_NAME}" created`);
  }

  if (!getInjectorByName(ANTHROPIC_INJECTOR_NAME)) {
    createInjector({
      name: ANTHROPIC_INJECTOR_NAME,
      route_id: route.id,
      inject_header: 'x-api-key',
      inject_value: apiKey,
      description: 'Anthropic API key (auto-created)',
    });
    console.log(`Injector "${ANTHROPIC_INJECTOR_NAME}" created`);
  }
}

/**
 * Grants the new session permission to use the default anthropic route with its injector.
 */
export function grantDefaultPermissions(sessionId: string): void {
  const route = getRouteByName(ANTHROPIC_ROUTE_NAME);
  if (!route) return;

  const injector = getInjectorByName(ANTHROPIC_INJECTOR_NAME);
  try {
    grantPermission(sessionId, route.id, injector?.id);
  } catch {
    /* already granted, e.g. from migrate */
  }
}

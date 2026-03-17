#!/usr/bin/env node
import { request as httpRequest } from 'http';

interface Route {
  id: string;
  name: string;
  type: string;
  domain_pattern?: string;
  path_prefix?: string;
  upstream_url?: string;
}

interface Injector {
  id: string;
  name: string;
  route_id: string;
  inject_header: string;
  inject_value: string;
}

interface Session {
  id: string;
  name: string;
  container_id?: string;
  container_name?: string;
  status: string;
  default_policy: string;
}

interface InjectorAssignment {
  id: string;
  injector_id: string;
  session_id: string;
}

const API_URL = process.env.NCG_API || 'http://127.0.0.1:3100';
const UPDATE_INTERVAL = 1000; // 1 second

async function fetchJson<T>(path: string): Promise<T | null> {
  return new Promise((resolve) => {
    const url = new URL(path, API_URL);
    httpRequest(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null)).end();
  });
}

async function fetchData() {
  const [routes, injectors, sessions] = await Promise.all([
    fetchJson<Route[]>('/api/routes'),
    fetchJson<Injector[]>('/api/injectors'),
    fetchJson<Session[]>('/api/sessions'),
  ]);

  return {
    routes: routes ?? [],
    injectors: injectors ?? [],
    sessions: sessions ?? [],
  };
}

async function getSessionInjectorAssignments(injectorName: string): Promise<string[]> {
  const assignments = await fetchJson<InjectorAssignment[]>(`/api/injectors/${encodeURIComponent(injectorName)}/assignments`);
  return assignments?.map((a) => a.session_id) ?? [];
}

function clear() {
  process.stdout.write('\x1B[2J\x1B[0f');
}

function bold(text: string): string {
  return `\x1B[1m${text}\x1B[0m`;
}

function dim(text: string): string {
  return `\x1B[2m${text}\x1B[0m`;
}

function render(data: { routes: Route[]; injectors: Injector[]; sessions: Session[] }) {
  const timestamp = new Date().toLocaleTimeString();
  const lines: string[] = [];

  lines.push(bold('═ (nano)clawgate Monitor ═') + dim(` [${timestamp}]`));
  lines.push('');

  // INJECTORS BY ROUTE
  lines.push(bold('INJECTORS'));
  if (data.routes.length === 0) {
    lines.push(dim('  (no routes)'));
  } else {
    for (const route of data.routes) {
      const routeInjectors = data.injectors.filter((i) => i.route_id === route.id);
      lines.push(`  ${bold(route.name)} [${route.type}]`);
      if (routeInjectors.length === 0) {
        lines.push(dim('    (no injectors)'));
      } else {
        for (const inj of routeInjectors) {
          lines.push(`    • ${inj.name}`);
          lines.push(`      ${dim(`header: ${inj.inject_header}`)}`);
        }
      }
    }
  }

  lines.push('');
  lines.push(bold('SESSIONS'));
  if (data.sessions.length === 0) {
    lines.push(dim('  (no sessions)'));
  } else {
    for (const session of data.sessions) {
      const statusIcon = session.status === 'active' ? '✓' : '✗';
      lines.push(`  ${bold(session.name)} [${statusIcon} ${session.status}]`);
      if (session.container_name) {
        lines.push(`    container: ${dim(session.container_name)}`);
      }
      lines.push(`    policy: ${session.default_policy}`);

      const sessionInjectors = data.injectors.filter((inj) => {
        const route = data.routes.find((r) => r.id === inj.route_id);
        return route !== undefined;
      });

      if (sessionInjectors.length === 0) {
        lines.push(dim('    (no injectors)'));
      } else {
        lines.push('    injectors:');
        for (const inj of sessionInjectors) {
          const route = data.routes.find((r) => r.id === inj.route_id);
          lines.push(`      • ${inj.name} (${route?.name || '?'})`);
        }
      }
    }
  }

  lines.push('');
  lines.push(dim('Press Ctrl+C to exit'));

  clear();
  process.stdout.write(lines.join('\n'));
}

async function main() {
  // Handle resize and Ctrl+C
  let isRunning = true;
  process.on('SIGINT', () => {
    isRunning = false;
    clear();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    isRunning = false;
    clear();
    process.exit(0);
  });

  // Initial render
  let data = await fetchData();
  render(data);

  // Update loop
  while (isRunning) {
    await new Promise((resolve) => setTimeout(resolve, UPDATE_INTERVAL));
    data = await fetchData();
    render(data);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

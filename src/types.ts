export interface Route {
  id: string;
  name: string;
  type: 'forward' | 'reverse';
  domain_pattern: string | null;  // forward: regex for domain
  path_prefix: string | null;     // reverse: e.g., '/anthropic'
  upstream_url: string | null;    // reverse: e.g., 'https://api.anthropic.com'
  description: string | null;
  created_at: string;
}

export interface Injector {
  id: string;
  name: string;
  route_id: string;
  inject_header: string;
  inject_value: string;
  description: string | null;
  created_at: string;
}

export interface Session {
  id: string;
  name: string;
  container_id: string | null;
  container_name: string | null;
  container_ip: string | null;
  project_dir: string | null;
  default_policy: 'allow' | 'deny';
  status: 'active' | 'stopped';
  created_at: string;
  stopped_at: string | null;
}

export interface Permission {
  id: string;
  session_id: string;            // '*' for global
  route_id: string;
  injector_id: string | null;
  granted_at: string;
}

export interface SessionLink {
  id: string;
  session_id: string;
  claude_session_id: string;
  first_seen_at: string;
  last_seen_at: string;
}

/** One call per locked key, and the literal an approver must type for it against the fake Nginx Proxy Manager. */
export interface LockCase {
  key: string;
  request: { method: string; path: string; body?: unknown; query?: Record<string, unknown> };
  confirm: string;
}

/** Where each create or update sends traffic: the approver must see it. */
export const DESTINATIONS = ['10.0.0.7:8096', '10.6.6.6', 'elsewhere.example', 'evil.example', '10.0.0.10:3389'];

/** Values in lock-case params that must never reach an approver or the audit log. */
export const PARAM_SECRETS = ['user-pw-555555', 'new-pw-666666', 'cur-pw-777777', '918273'];

export const LOCK_CASES: LockCase[] = [
  {
    key: 'POST /nginx/proxy-hosts',
    request: {
      method: 'POST',
      path: '/nginx/proxy-hosts',
      body: {
        domain_names: ['media.home.example'],
        forward_scheme: 'http',
        forward_host: '10.0.0.7',
        forward_port: 8096,
        certificate_id: 'new',
        ssl_forced: true,
      },
    },
    confirm: 'media.home.example',
  },
  {
    key: 'PUT /nginx/proxy-hosts/{hostID}',
    request: { method: 'PUT', path: '/nginx/proxy-hosts/1', body: { forward_host: '10.6.6.6', forward_port: 80 } },
    confirm: 'app.home.example',
  },
  {
    key: 'POST /nginx/proxy-hosts/{hostID}/disable',
    request: { method: 'POST', path: '/nginx/proxy-hosts/1/disable' },
    confirm: 'app.home.example',
  },
  {
    key: 'POST /nginx/proxy-hosts/{hostID}/enable',
    request: { method: 'POST', path: '/nginx/proxy-hosts/1/enable' },
    confirm: 'app.home.example',
  },
  {
    key: 'DELETE /nginx/proxy-hosts/{hostID}',
    request: { method: 'DELETE', path: '/nginx/proxy-hosts/1' },
    confirm: 'app.home.example',
  },
  {
    key: 'POST /nginx/redirection-hosts',
    request: {
      method: 'POST',
      path: '/nginx/redirection-hosts',
      body: {
        domain_names: ['go.home.example'],
        forward_scheme: 'https',
        forward_http_code: 302,
        forward_domain_name: 'elsewhere.example',
      },
    },
    confirm: 'go.home.example',
  },
  {
    key: 'PUT /nginx/redirection-hosts/{hostID}',
    request: { method: 'PUT', path: '/nginx/redirection-hosts/1', body: { forward_domain_name: 'evil.example' } },
    confirm: 'old.home.example',
  },
  {
    key: 'POST /nginx/redirection-hosts/{hostID}/disable',
    request: { method: 'POST', path: '/nginx/redirection-hosts/1/disable' },
    confirm: 'old.home.example',
  },
  {
    key: 'POST /nginx/redirection-hosts/{hostID}/enable',
    request: { method: 'POST', path: '/nginx/redirection-hosts/1/enable' },
    confirm: 'old.home.example',
  },
  {
    key: 'DELETE /nginx/redirection-hosts/{hostID}',
    request: { method: 'DELETE', path: '/nginx/redirection-hosts/1' },
    confirm: 'old.home.example',
  },
  {
    key: 'POST /nginx/dead-hosts#advanced',
    request: {
      method: 'POST',
      path: '/nginx/dead-hosts',
      body: { domain_names: ['x.home.example'], advanced_config: 'location / { proxy_pass http://10.9.9.9; }' },
    },
    confirm: 'x.home.example',
  },
  {
    key: 'PUT /nginx/dead-hosts/{hostID}#advanced',
    request: { method: 'PUT', path: '/nginx/dead-hosts/1', body: { advanced_config: 'return 302 https://x.example;' } },
    confirm: 'gone.home.example',
  },
  {
    key: 'POST /nginx/dead-hosts/{hostID}/disable',
    request: { method: 'POST', path: '/nginx/dead-hosts/1/disable' },
    confirm: 'gone.home.example',
  },
  {
    key: 'DELETE /nginx/dead-hosts/{hostID}',
    request: { method: 'DELETE', path: '/nginx/dead-hosts/1' },
    confirm: 'gone.home.example',
  },
  {
    key: 'POST /nginx/streams',
    request: {
      method: 'POST',
      path: '/nginx/streams',
      body: { incoming_port: 3333, forwarding_host: '10.0.0.10', forwarding_port: 3389, tcp_forwarding: true },
    },
    confirm: '3333',
  },
  {
    key: 'PUT /nginx/streams/{streamID}',
    request: { method: 'PUT', path: '/nginx/streams/1', body: { forwarding_host: '10.6.6.6', forwarding_port: 22 } },
    confirm: '2222',
  },
  {
    key: 'POST /nginx/streams/{streamID}/disable',
    request: { method: 'POST', path: '/nginx/streams/1/disable' },
    confirm: '2222',
  },
  {
    key: 'POST /nginx/streams/{streamID}/enable',
    request: { method: 'POST', path: '/nginx/streams/1/enable' },
    confirm: '2222',
  },
  {
    key: 'DELETE /nginx/streams/{streamID}',
    request: { method: 'DELETE', path: '/nginx/streams/1' },
    confirm: '2222',
  },
  {
    key: 'DELETE /nginx/certificates/{certID}',
    request: { method: 'DELETE', path: '/nginx/certificates/1' },
    confirm: 'Home wildcard',
  },
  {
    key: 'PUT /nginx/access-lists/{listID}',
    request: { method: 'PUT', path: '/nginx/access-lists/1', body: { name: 'Family', satisfy_any: true, items: [] } },
    confirm: 'Family',
  },
  {
    key: 'DELETE /nginx/access-lists/{listID}',
    request: { method: 'DELETE', path: '/nginx/access-lists/1' },
    confirm: 'Family',
  },
  {
    key: 'POST /users',
    request: {
      method: 'POST',
      path: '/users',
      body: {
        name: 'Sam',
        nickname: 'sam',
        email: 'sam@home.example',
        roles: ['admin'],
        auth: { type: 'password', secret: 'user-pw-555555' },
      },
    },
    confirm: 'sam@home.example',
  },
  {
    key: 'PUT /users/{userID}',
    request: { method: 'PUT', path: '/users/2', body: { email: 'mallory@evil.example', roles: ['admin'] } },
    confirm: 'alex@home.example',
  },
  {
    key: 'PUT /users/{userID}/auth',
    request: {
      method: 'PUT',
      path: '/users/2/auth',
      body: { type: 'password', current: 'cur-pw-777777', secret: 'new-pw-666666' },
    },
    confirm: 'alex@home.example',
  },
  {
    key: 'PUT /users/{userID}/permissions',
    request: { method: 'PUT', path: '/users/2/permissions', body: { visibility: 'all', proxy_hosts: 'manage' } },
    confirm: 'alex@home.example',
  },
  {
    key: 'POST /users/{userID}/2fa',
    request: { method: 'POST', path: '/users/2/2fa' },
    confirm: 'alex@home.example',
  },
  {
    key: 'POST /users/{userID}/2fa/enable',
    request: { method: 'POST', path: '/users/2/2fa/enable', body: { code: '918273' } },
    confirm: 'alex@home.example',
  },
  {
    key: 'POST /users/{userID}/2fa/backup-codes',
    request: { method: 'POST', path: '/users/2/2fa/backup-codes', body: { code: '918273' } },
    confirm: 'alex@home.example',
  },
  {
    key: 'DELETE /users/{userID}/2fa',
    request: { method: 'DELETE', path: '/users/2/2fa', query: { code: '918273' } },
    confirm: 'alex@home.example',
  },
  {
    key: 'DELETE /users/{userID}',
    request: { method: 'DELETE', path: '/users/2' },
    confirm: 'alex@home.example',
  },
  {
    key: 'PUT /settings/{settingID}',
    request: {
      method: 'PUT',
      path: '/settings/default-site',
      body: { value: 'redirect', meta: { redirect: 'https://elsewhere.example' } },
    },
    confirm: 'default-site',
  },
];

import { LOCATION_ID, LOCATION_TARGET, PETSTORE_UID, TASK_ID } from './fake-backstage.js';

/** One call per locked key, and the literal an approver must type for it against the fake Backstage. */
export interface LockCase {
  key: string;
  request: { method: string; path: string; body?: unknown; query?: Record<string, unknown> };
  confirm: string;
  /** Text the approval must show: where the call reaches. */
  shows: string;
}

export const SCAFFOLD_SECRET = 'gho_scaffold-secret-222222';
export const RETRY_SECRET = 'gho_retry-secret-333333';

export const LOCK_CASES: LockCase[] = [
  {
    key: 'DELETE /api/catalog/entities/by-uid/{uid}',
    request: { method: 'DELETE', path: `/api/catalog/entities/by-uid/${PETSTORE_UID}` },
    confirm: 'petstore',
    shows: 'component:default/petstore',
  },
  {
    key: 'POST /api/catalog/locations',
    request: {
      method: 'POST',
      path: '/api/catalog/locations',
      body: { type: 'url', target: 'https://github.com/someone/else/blob/main/all.yaml' },
    },
    confirm: 'https://github.com/someone/else/blob/main/all.yaml',
    shows: 'POST /api/catalog/locations from url:https://github.com/someone/else/blob/main/all.yaml:',
  },
  {
    key: 'PUT /api/catalog/locations/{id}',
    request: {
      method: 'PUT',
      path: `/api/catalog/locations/${LOCATION_ID}`,
      body: { type: 'url', target: 'https://github.com/someone/else/blob/main/moved.yaml' },
    },
    confirm: LOCATION_TARGET,
    shows: 'https://github.com/someone/else/blob/main/moved.yaml',
  },
  {
    key: 'DELETE /api/catalog/locations/{id}',
    request: { method: 'DELETE', path: `/api/catalog/locations/${LOCATION_ID}` },
    confirm: LOCATION_TARGET,
    shows: `url:${LOCATION_TARGET}`,
  },
  {
    key: 'POST /api/scaffolder/v2/tasks',
    request: {
      method: 'POST',
      path: '/api/scaffolder/v2/tasks',
      body: {
        templateRef: 'template:default/react-app',
        values: { name: 'checkout', repoUrl: 'github.com?owner=acme&repo=checkout' },
        secrets: { USER_OAUTH_TOKEN: SCAFFOLD_SECRET },
      },
    },
    confirm: 'template:default/react-app',
    shows: 'template:default/react-app (React app)',
  },
  {
    key: 'POST /api/scaffolder/v2/tasks/{taskId}/cancel',
    request: { method: 'POST', path: `/api/scaffolder/v2/tasks/${TASK_ID}/cancel` },
    confirm: 'react-app',
    shows: 'template:default/react-app (task processing)',
  },
  {
    key: 'POST /api/scaffolder/v2/tasks/{taskId}/retry',
    request: {
      method: 'POST',
      path: `/api/scaffolder/v2/tasks/${TASK_ID}/retry`,
      body: { secrets: { USER_OAUTH_TOKEN: RETRY_SECRET } },
    },
    confirm: 'react-app',
    shows: 'template:default/react-app (task processing)',
  },
  {
    key: 'POST /api/notifications/notifications',
    request: {
      method: 'POST',
      path: '/api/notifications/notifications',
      body: { recipients: { type: 'broadcast' }, payload: { title: 'Maintenance tonight' } },
    },
    confirm: 'Backstage',
    shows: 'broadcast',
  },
  {
    key: 'POST /api/events/bus/v1/events',
    request: {
      method: 'POST',
      path: '/api/events/bus/v1/events',
      body: { event: { topic: 'github.push', payload: { ref: 'refs/heads/main' } } },
    },
    confirm: 'Backstage',
    shows: 'github.push',
  },
];

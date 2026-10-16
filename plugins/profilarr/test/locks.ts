/** One call per locked key, and the literal an approver must type for it against the fake Profilarr. */
export interface LockCase {
  key: string;
  request: { method: string; path: string; body?: unknown; query?: Record<string, unknown> };
  confirm: string;
}

export const LOCK_CASES: LockCase[] = [
  {
    key: 'POST /databases',
    request: {
      method: 'POST',
      path: '/databases',
      body: {
        name: 'Elsewhere',
        repository_url: 'https://github.com/someone/profiles',
        personal_access_token: 'ghp_link-pat-555555',
        auto_pull: true,
        sync_strategy: 1,
      },
    },
    confirm: 'Profilarr',
  },
  {
    key: 'PATCH /databases/{id}',
    request: {
      method: 'PATCH',
      path: '/databases/1',
      body: { name: 'Renamed', auto_pull: true, personal_access_token: 'ghp_new-pat-333333' },
    },
    confirm: 'Dictionarry',
  },
  {
    key: 'POST /databases/{id}/sync',
    request: { method: 'POST', path: '/databases/1/sync' },
    confirm: 'Dictionarry',
  },
  {
    key: 'DELETE /databases/{id}',
    request: { method: 'DELETE', path: '/databases/1' },
    confirm: 'Dictionarry',
  },
  {
    key: 'DELETE /backups/{filename}',
    request: { method: 'DELETE', path: '/backups/backup-2026-10-14-100005.tar.gz' },
    confirm: 'backup-2026-10-14-100005.tar.gz',
  },
  {
    key: 'PATCH /backups/settings',
    request: { method: 'PATCH', path: '/backups/settings', body: { retentionDays: 1 } },
    confirm: 'Profilarr',
  },
];

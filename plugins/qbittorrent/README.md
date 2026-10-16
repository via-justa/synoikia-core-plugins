# qBittorrent

qBittorrent 5.x for Synoikia: torrents, categories, tags, transfer limits, logs, RSS and search, from a fixed set of WebUI API v2 operations declared in `plugin.yaml` (qBittorrent serves no API spec). Design: [`docs/designs/qbittorrent.md`](../../docs/designs/qbittorrent.md).

The sandbox calls `qbittorrent.call(key, params)` with flat params, named as qBittorrent names them (`torrents.setCategory`, `{ hashes, category }`). A read sends them as the query, a write as a form (`torrents.add` as multipart). Every call goes through Synoikia's permission gate, approvals, redaction and audit log; this plugin only describes qBittorrent's API.

## Files

| File              | What                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `manifest.json`   | Binding, connection form, `sensitiveKeys` and network hosts                                      |
| `plugin.yaml`     | The declared operations, locks, split twins, confirmation sources, sensitive params and results  |
| `instructions.md` | How to call the API, for the model                                                               |
| `src/plugin.ts`   | Handlers: param checks, split twins, request bodies, invoke                                      |
| `src/session.ts`  | Sign-in with the WebUI username and password; the session cookie (`SID` or `QBT_SID_<port>`)     |
| `src/params.ts`   | Declared names only, types, case-duplicates, torrent hashes and `all`                            |
| `src/mask.ts`     | URLs in results masked to their origin plus a token; writes take the token back                  |
| `src/stored.ts`   | Reads of the stored torrents, categories, tags, RSS items and rules, search plugins and trackers |
| `src/targets.ts`  | Targets of each write and the confirmation literals taken from them                              |
| `src/summary.ts`  | Approval texts, destination first                                                                |
| `src/policy.ts`   | Locks that must exist; the plugin refuses to load without them                                   |
| `test/`           | A fake qBittorrent, unit, golden and e2e tests on Synoikia's harness                             |

## Connection

See the manifest's `connection.help`: the WebUI base URL, username and password. qBittorrent 5.0 or later (WebUI API 2.11).

## Locked operations

| Operation                                                                                                                                                                                                    | Confirm                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `torrents.delete`, `torrents.delete#with-files`, `torrents.setLocation`, `torrents.setSavePath`                                                                                                              | the torrent's name, `<n> torrents`, or `all <n> torrents` |
| `#all` twins of stop, start, recheck, reannounce, setCategory, tags, limits, share limits                                                                                                                    | `all <n> torrents`                                        |
| `torrents.setShareLimits#remove` (a share limit that removes torrents)                                                                                                                                       | the torrent's name or `<n> torrents`                      |
| `torrents.addTrackers`, `torrents.editTracker`, `torrents.removeTrackers`                                                                                                                                    | the torrent's name                                        |
| `torrents.editCategory`, `torrents.removeCategories`                                                                                                                                                         | the category names                                        |
| `torrents.deleteTags`                                                                                                                                                                                        | the tag names                                             |
| `rss.setFeedURL`, `rss.removeItem`                                                                                                                                                                           | the stored feed or folder path                            |
| `rss.setRule`, `rss.removeRule`                                                                                                                                                                              | the stored rule name (a new rule: the host name)          |
| `search.uninstallPlugin`, `search.enablePlugin`                                                                                                                                                              | the plugin names                                          |
| `torrents.createCategory#paths` (a new category with its own save path), `torrents.add`, `app.setPreferences`, `app.shutdown`, `rss.addFeed`, `search.start`, `search.installPlugin`, `search.updatePlugins` | the base URL's host name                                  |

Sign-in, cookies, the API key, `torrents/export`, the directory browser, torrent creation and uploads from disk are not declared at all.

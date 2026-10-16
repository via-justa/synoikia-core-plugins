# qBittorrent

Call `qbittorrent.call(key, params)`. Keys are `<group>.<method>` of the WebUI API v2 (`torrents.info`,
`torrents.setCategory`, `sync.maindata`). Params are one flat object, named exactly as qBittorrent names them
(case matters): `qbittorrent.call('torrents.info', { filter: 'downloading', sort: 'added_on', reverse: true, limit: 20 })`.
Unknown names are refused.

## Ids and formats

- Torrents are named by `hash` (40 hex characters, from `torrents.info`). Writes on several torrents take `hashes`,
  joined with `|`; `hashes: 'all'` means every torrent and needs a typed confirmation.
- Tags are joined with `,`; category names in `torrents.removeCategories` one per line; URLs in `torrents.add` and
  `torrents.addTrackers` one per line.
- Limits are bytes per second; 0 or -1 is unlimited. Share limits: -2 global, -1 none; times in minutes.
- File priorities: 0 skip, 1 normal, 6 high, 7 maximal; `id` is file indexes from `torrents.files`, joined with `|`.
- RSS paths join folders with a backslash: `Folder\Feed`.
- `app.setPreferences` takes `{ json: { name: value } }` with only the preferences to change.

## URLs in results

Tracker, web seed, feed and search result URLs can hold passkeys, so results show them as their origin plus a
token, like `https://tracker.example/<masked:1a2b3c4d5e6f>`. Pass a masked URL back as is: `torrents.add`,
`torrents.editTracker`, `torrents.removeTrackers` and `rss.setRule` (`affectedFeeds`) resolve it. Magnet links keep
their hash and name.

## Common workflows

- Overview: `transfer.info`, then `torrents.info` with `filter` (downloading, seeding, completed, stopped, running,
  active, stalled, errored). For polling, `sync.maindata` with the `rid` of the previous response.
- One torrent: `torrents.properties`, `torrents.files`, `torrents.trackers` with `hash`.
- Organize: `torrents.categories`, then `torrents.setCategory` or `torrents.addTags`; `torrents.createCategory` first
  if needed.
- Search and add: `search.plugins`, `search.start` (returns `id`), poll `search.status` until `Stopped`, read
  `search.results`, then `torrents.add` with the chosen `fileUrl` and a `category` or `savepath`.
- Pause and resume: `torrents.stop` and `torrents.start` (qBittorrent 5 names; there is no pause or resume).

## Locked and excluded

Removing torrents (`deleteFiles: true` deletes data), adding torrents, moving data, setting categories' paths,
deleting categories or tags, tracker edits, preferences, shutdown, RSS writes, starting a search (it runs search
plugins) and search plugin changes need a human who types a confirmation. Sign-in, cookies, the API key, torrent file export
and uploads from disk are not available.

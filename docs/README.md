# Plugin designs

The original per-server designs the TrueNAS, Seerr and Home Assistant plugins come from. Each was written for a standalone MCP server; [Synoikia](https://github.com/via-justa/synoikia-core) replaced that deployment with one server and plugins, and implements the shared parts (sandbox, permission gate, approvals, admin portal) once in core. What stays specific to each upstream (catalog discovery, classification, locked operations, targets, config edits) is what the plugins here implement.

| Plugin         | Design                                                 |
| -------------- | ------------------------------------------------------ |
| TrueNAS        | [`designs/truenas.md`](designs/truenas.md)             |
| Seerr          | [`designs/seerr.md`](designs/seerr.md)                 |
| Home Assistant | [`designs/homeassistant.md`](designs/homeassistant.md) |

Where a design and Synoikia's [design document](https://github.com/via-justa/synoikia-core/blob/main/docs/design/unified-mcp-server.md) disagree, Synoikia's wins: for example, access levels per group replace the per-operation Enabled toggles, and approvals happen only on Synoikia's approval page.

`mockups/homeassistant-match-selector` is the chosen design for the Home Assistant target picker on the Pre-Approval Rules form. The admin portal mockups the designs refer to are in Synoikia's [`docs/mockups/admin-portal`](https://github.com/via-justa/synoikia-core/tree/main/docs/mockups/admin-portal). The `.dc.html` files are Claude Design Component sources: read the markup as a spec, or paste one into a new Claude Design artifact to render it.

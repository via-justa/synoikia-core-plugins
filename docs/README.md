# Plugin designs

The original per-server designs the TrueNAS, Seerr and Home Assistant plugins come from. Each was written for a standalone MCP server; [Synoikia](https://github.com/via-justa/synoikia-core) replaced that deployment with one server and plugins, and implements the shared parts (sandbox, permission gate, approvals, admin portal) once in core. What stays specific to each upstream (catalog discovery, classification, locked operations, targets, config edits) is what the plugins here implement.

| Plugin         | Design                                                 |
| -------------- | ------------------------------------------------------ |
| TrueNAS        | [`designs/truenas.md`](designs/truenas.md)             |
| Seerr          | [`designs/seerr.md`](designs/seerr.md)                 |
| Home Assistant | [`designs/homeassistant.md`](designs/homeassistant.md) |

These designs apply only to the parts that are specific to each upstream. Synoikia's [software design description](https://github.com/via-justa/synoikia-core/blob/main/docs/design/README.md) applies to all other parts: access levels, approvals, redaction and the admin portal. If a design here and the Synoikia design do not agree, the Synoikia design applies.

`mockups/homeassistant-match-selector` is the chosen design for the Home Assistant target picker on the Pre-Approval Rules form. The admin portal mockups the designs refer to are in Synoikia's [`docs/mockups/admin-portal`](https://github.com/via-justa/synoikia-core/tree/main/docs/mockups/admin-portal). The `.dc.html` files are Claude Design Component sources: read the markup as a spec, or paste one into a new Claude Design artifact to render it.

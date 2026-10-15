---
kind: package-reference
description: "Product sidebar brand"
---

# @deepseek-ai/dsh-client-ui-brand-product

English | [中文](README.zh.md)

## Summary

This private desktop plugin occupies `sidebar.brand.mark` and `sidebar.brand.name`. The mark is empty and the name displays OpenGameGen. Product defaults disable the official brand before inserting this plugin.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

The desktop product bundle mounts this package; its Node entry is inert.

## Understand the implementation

Registrations wait for slot declarations and dispose with the plugin. No model requests or session logs change.

## Model Experience

None, as this package contributes browser presentation without model messages or tools.

#### KV Cache effect

None; this package does not assemble provider requests.

## Known Limitations and Deferred Work

- The plugin only changes sidebar branding; installer identity and storage roots belong to the desktop shell.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Keep the public slot and desktop product bundle compatible when merging upstream updates.

</details>

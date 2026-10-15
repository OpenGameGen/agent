---
kind: package-reference
description: "Product environment settings"
---

# @deepseek-ai/dsh-client-ui-product-environments

English | [中文](README.zh.md)

## Summary

This private desktop plugin adds Creation environments to the public `settings.general.item` slot. Its localized button opens the desktop environment manager through the Electron bridge.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

The desktop product bundle mounts this package; its Node entry is inert.

## Understand the implementation

The Node entry is inert. Browser activation registers locale and slot effects; the desktop-host product bundle delivers the client package. The button does not call the model or write session logs.

## Model Experience

None, as this package contributes browser presentation without model messages or tools.

#### KV Cache effect

None; this package does not assemble provider requests.

## Known Limitations and Deferred Work

- The entry requires the product desktop bridge; ordinary Web deployments cannot open the native manager. Preparation, cancellation and tool reuse belong to the environment manager.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Keep the public slot and desktop product bundle compatible when merging upstream updates.

</details>

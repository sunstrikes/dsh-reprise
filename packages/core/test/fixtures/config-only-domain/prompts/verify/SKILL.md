---
name: verify
description: The verify prompt of the config-only fixture pack, which exists to prove a second domain needs no kernel change.
---

# VERIFY — CONFIG-ONLY-DOMAIN-VERIFY

This pack is only configuration. It declares one knob, one metric, one hypothesis class and five
prompts, and the kernel reads all of it without a single edit. If this file's marker ever shows up in
a shipped prompt, it means the two packs were confused.

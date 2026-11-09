# Nested panel resize scheduling

`react-resizable-panels` 4.12.2 synchronously commits panel sizes from its native
ResizeObserver callback. In RepoLens's three nested groups, changing from the
mobile chat view back to four columns produced undelivered-notification errors.
The reproduction is `e2e/chat-presentation.spec.ts`; its native observer probe
now asserts zero errors after all graph nodes stabilize for 24 frames.

Postinstall patches both ESM and CommonJS distributions. The original callback
runs on the next animation frame with the latest observation for each target.
A 32ms task fallback handles native-hidden Electron windows whose animation frames pause despite a visible document. The first callback cancels the other; disconnect cancels both and clears the entries. No error handler,
browser warning filter or global ResizeObserver replacement is installed.

The patch is version- and structure-checked and idempotent. Upgrade the pinned
panel package only after reviewing/removing the patch and running resizing,
keyboard, preference restore, chat, mobile and graph geometry regressions.
The upstream MIT license remains in the installed package. This temporary
integration patch must not silently apply to a different release.

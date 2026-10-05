# PwrFinicky renderer

Load `index.html` in the Electron window. This renderer uses local HTML, CSS, and native browser ES modules; it needs no bundler or renderer-side Node integration.

The preload must expose `window.pwrfinicky.request(method, params = {})` and `window.pwrfinicky.onState(callback)`, returning an unsubscribe function. All configuration changes, native file actions, launches, and external links go through that bridge. No bridge method changes system defaults until the user presses **Set as default browser**.

`app.mjs` exports `createRenderer(root, bridge)` with `start()` and `destroy()` for integration tests. `model.mjs` holds draft serialization, validation, ordering, and bounded history helpers. Live state updates preserve unsaved drafts and input focus; saves preserve edits made while their request is pending.

Run the interaction and model tests from the repository root after the app's `jsdom` development dependency is installed:

```sh
node --test apps/pwrfinicky/tests/ui*.test.mjs
```

Activity displays the newest 100 real dispatches from the bridge. Dry runs stay in the Test view. Configuration errors remain visible across all views while the backend continues using its last good configuration. The Settings view includes the upstream Finicky attribution and MIT license link.

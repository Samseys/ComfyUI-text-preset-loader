# ComfyUI text preset loader — working notes

A ComfyUI custom node for organising, composing and reusing text prompts. ~5.6k
lines: Python backend (node + HTTP routes) and vanilla ES modules for two
frontends — the node widget on ComfyUI's canvas, and a standalone browse page.

## Layout

Dependencies point one way, and the directories say which way. Nothing below the
line knows about aiohttp or the DOM; nothing in `core/` knows about the DOM.

```
__init__.py            ComfyUI entry point; calls register_routes()
preset_loader.py       HTTP routes + PresetLoaderNode
preset_previews.py     preview upload / decode / safe filenames
preset_storage.py      caching, atomic writes, recovery
preset_model.py        shape, validation, resolution — pure, no I/O

web/preset_loader.js   the canvas node widget — entry point
web/browse.js          the standalone library page — entry point
web/core/model.js      twin of preset_model.py
web/core/api.js        fetch wrappers
web/core/store.js      shared snapshot + SSE subscription
web/ui/picker.js       the browse/select popover
web/ui/editor.js       parts editor, preset editor, part creator
web/ui/dialog.js       openDialog / openPopover — every overlay
web/ui/dnd.js          pointer drag + edge autoscroll
web/ui/icons.js        Lucide icons, pathTone, element() — imports nothing
web/styles/ui.css      all component styles + design tokens
web/styles/browse.css  browse-page-only styles
```

`web/preset_loader.js` is pinned to `web/` root: it imports ComfyUI's
`../../scripts/app.js`, which only resolves from that depth. Moving it breaks the
canvas widget silently — nothing outside a running ComfyUI will notice.

## Running and verifying without ComfyUI

`register_routes()` is explicit rather than an import side effect, so the whole
package loads with no `server` module present. Use ComfyUI's own interpreter so
aiohttp/Pillow versions match:

```
C:/Users/samse/AppData/Local/Comfy-Desktop/ComfyUI-Installs/ComfyUI/ComfyUI/.venv/Scripts/python.exe
```

Serve the routes straight from the working tree:

```python
import sys, types
REPO = "<repo path>"
shim = types.ModuleType("pkg"); shim.__path__ = [REPO]
sys.modules["pkg"] = shim
from aiohttp import web
import pkg.preset_loader as PL
table = web.RouteTableDef(); PL.register_routes(table)
app = web.Application(); app.add_routes(table)
web.run_app(app, host="127.0.0.1", port=8899)
```

Then `http://127.0.0.1:8899/preset_loader/browse` exercises the editor, picker,
dialogs and drag — everything except the canvas widget. With no `folder_paths`
importable, storage falls back to `<repo>/text-preset-loader/` (gitignored), so
testing never touches the real library. `aiohttp.test_utils.TestClient` works
for route-level checks.

The node widget can only be verified inside ComfyUI. There is no test suite,
deliberately — verify by exercising the running thing.

## Gotchas

**Never reorder the widgets in `INPUT_TYPES`.** ComfyUI serialises widget values
into `widgets_values`, a positional array with no keys, and restores by index.
`text` must stay first or every workflow saved before `preset` existed loads its
text into the wrong widget. New widgets go at the end.

**`/preset_loader/assets/` is the one place a URL reaches the filesystem.** It
serves any `.js`/`.css` under `web/`, including nested paths, and it is guarded
by resolving the candidate and checking containment in `WEB_DIR` — not by
inspecting the string. Resolution is what collapses `..` and follows symlinks, so
a string check cannot see that a link inside `web/` points out of it. Note also
that `WEB_DIR / filename` *discards* `WEB_DIR` when `filename` is absolute, which
is why containment is checked on the result rather than assumed from the join.
Everything rejected answers 404, never 403, so the route is not an existence
oracle. Adding a module needs no registration; loosening any of this does.

**`read_presets()` returns the live cache.** Pass `copy_data=True` before
mutating. The node's resolution memo relies on that object being
identity-stable, so handing out a mutable reference and changing it corrupts
both. Mutating routes must also pass `strict=True`, so a write is never based on
a library that failed validation.

**`preset_model.py` and `web/core/model.js` mirror the *shape*, not the name
rules.** The shape half — parts, resolution order, blank-line joining — must stay
in lockstep, because both frontends resolve and display straight from the store
snapshot with no round trip; a divergence there shows the user a prompt the
backend will not produce. Name validation is deliberately asymmetric: the client
runs a cheap subset (empty, too long, illegal character, empty segment, `.`/`..`,
bare `Parts`) purely so the editor can answer inline, and the server owns the
rest. Do not "restore parity" — the server re-validates every write and is the
only authority.

**Data lives in ComfyUI's user directory**, not the package. `data/` only seeds
a library that does not exist yet. Never write to `data/` at runtime — an
update would wipe it.

**No build step.** TypeScript, JSX or bundling would require committing build
output or breaking git-clone installs. If type safety is wanted, use
`// @ts-check` + JSDoc. Note that ComfyUI serves `web/` verbatim including
subdirectories, and its extension scan globs `**/*.js` recursively — so every
module is fetched and evaluated as an extension, not just the entry points. They
are side-effect-free, which is why only `preset_loader.js` registers anything.

**The browse page runs under a strict CSP** (`default-src 'self'`, no inline
script). No CDNs, no inline `<script>`. That is why icons are vendored into
`web/ui/icons.js` rather than fetched.

**`web/ui/icons.js` must not import anything.** `dialog.js` needs `iconSvg` and
`editor.js` needs `openDialog`; the leaf module is what stops that becoming a
load-order-dependent cycle.

**CSS tokens are declared on `.pl-scope` / `.pl-dialog` / `.pl-popover`, not
`:root`.** Half of this renders inside ComfyUI's document; `:root` variables
would leak into ComfyUI and any other extension. All classes are `pl-` prefixed
for the same reason.

**`crypto.randomUUID()` is unavailable over plain HTTP.** Phones reach ComfyUI on
a LAN IP, which is not a secure context, so it is `undefined` there. Use the
`uid()` fallback.

**Dragging is the only way to reorder parts.** There are no up/down buttons and
no keyboard path. `web/ui/dnd.js` therefore matters: it autoscrolls on a
`requestAnimationFrame` loop rather than off `pointermove`, because a finger
resting in the edge zone fires no move events, and it re-checks placement each
scrolled frame since content slides under a stationary pointer. The handle needs
`touch-action: none` or the browser claims the gesture as a page scroll.

**`IS_CHANGED` hashes the resolved output**, not the widget values. A preset key
does not change when the preset — or a part it composes — is edited, so hashing
inputs would serve a stale cached prompt.

**Invalid preset names are repaired, not rejected.** `presets.json` is meant to
be hand-editable, so one bad name must not lock the library. `repair_library()`
coerces names and rewrites references through the same rename map; without that
rewrite, repairing a name orphans every composition pointing at it.

## Conventions

- **Comments say why the code is the way it is now.** Not what it used to be, not
  what changed. If a comment reads like a changelog entry, rewrite it.
- **No test suite** — this is a small plugin and that is a deliberate choice.
- Every overlay goes through `openDialog` or `openPopover`. Do not hand-roll a
  backdrop, an Escape handler or a dismissal listener.
- No inline `style.cssText`. Styles belong in `web/styles/ui.css`. Inline styles are
  for values only computable at runtime: measured geometry, drag offsets, and
  the dropdown background sampled from ComfyUI's live theme.
- Server is the authority on validation; client-side checks exist for message
  quality, never for safety.

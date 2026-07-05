# cc-htmlfeedback

<p align="center">
  <img src="docs/media/cc-htmlfeedback-demo.webp" alt="cc-htmlfeedback demo: highlight text on the page to leave a comment, saved as a draft; clicking Fix turns it into a ticket Claude Code applies and verifies live" width="800">
</p>

A zero-dependency, in-page feedback tool. **Highlight text on the page to leave a comment** - that's how every note is made - then either copy the structured feedback or let Claude Code fix it live.

## Two modes

1. **Simple (start here).** Chrome extension only. Highlight text, write notes, **copy** the structured feedback and paste it wherever you want. No server, no setup beyond loading the extension.
2. **Advanced (live fixes).** A Claude Code plugin serves your HTML page; comments start as local drafts, and clicking **Fix** (or **Fix all**) turns them into a ticket Claude applies and verifies on the fly - the page updates in place, no reload.

Get the simple mode working first, then add the plugin when you want live fixes.

## Features

- **Highlight to comment.** Select text -> popover. `Enter` = comment, `Backspace` on an empty box = strikethrough. Select blank space to mark "something's missing here".
- **Structured side panel.** Every note captures its section heading, the quoted text, surrounding context, and your note. Dock it left/right; undo/redo with `cmd/ctrl+Z`.
- **One-click export.** Copy clean, structured feedback (with the page URL) to paste anywhere.
- **Live fixes with Claude Code.** Connect to a Claude Code session: comments save as drafts, and clicking **Fix** (or **Fix all**) sends them to the work queue - Claude edits the source and the page updates in place, no reload.

## Simple mode: Chrome extension

The widget loads as a Chrome extension - this is all you need for copy-paste feedback.

### Load the extension
1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the `extension/` folder.
4. Pin the icon, then click it on any page to show/hide the widget.

> Chrome blocks injection on internal pages (`chrome://`, the Web Store, etc.) - that's a browser restriction.

### Try it first
Open `playground_file.html` in your browser and load the extension to play with every feature on a sample document.

## Advanced mode: live fixes with Claude Code

Once the extension works, add the plugin to skip the copy-paste: comments become tickets that Claude Code applies and verifies for you. For the full end-to-end walkthrough, see [`docs/how-it-works.md`](docs/how-it-works.md) (or its [animated version](docs/how-it-works.html)).

Install the plugin once (it bundles the skill plus the server it runs):

```
/plugin marketplace add leetwito/cc-htmlfeedback
/plugin install cc-htmlfeedback@cc-htmlfeedback
```

Then, in your project's Claude Code session:

```
/cc-htmlfeedback                          # serve the current dir on :4317
/cc-htmlfeedback http://localhost:5173    # or proxy your existing dev server (keeps HMR)
/cc-htmlfeedback stop                     # stop the loop + server
```

Highlight anything, write what you want changed - it's saved as a draft, not sent. When you're ready, click **Fix** on a card (or **Fix all**) and watch the ticket go `todo -> in-progress -> done` as Claude fixes it and verifies in a separate tab. Open several pages at once and they're fixed concurrently. Git is your undo.

## Build

`feedback-widget.html` is the single source of truth for the widget. `build.js` regenerates the
Chrome-extension widget and assembles the bundled plugin (`plugins/cc-htmlfeedback/`):

```bash
npm run build     # build extension/feedback-widget.js + assemble plugins/cc-htmlfeedback/
npm run check     # verify all outputs are in sync (no writes; non-zero on drift)
```

## License

MIT - see [LICENSE](LICENSE).

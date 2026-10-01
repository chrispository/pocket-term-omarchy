# Pocket Term — Omarchy

Pocket Term is a Nintendo 3DS terminal client with an Omarchy companion. It was originally forked from [Pocket Term](https://github.com/pocket-stack/pocket-term). Run shells on your Omarchy host from the 3DS with a touch keyboard and session tabs. The `>_` menu gives quick access to tools such as nvim and Git commands. Voice dictation is extremely fast and runs on the Omarchy host's Voxtype, which is pre-installed on all Omarchy installations. 

Press the voice key once to start dictation, and again to end it.

<p><img src="docs/readme-keyboard.png" width="320" alt="Pocket Term touch keyboard with a command menu key" /></p>
<p><img src="docs/readme-commands.png" width="660" alt="The command menu with nvim and Git groups, alongside Git shortcuts" /></p>

Configure the tools and options in [config.jsonc](config.jsonc). You can create your own macros like "Long holding A turns it into holding Alt."

Hitting select turns the keyboard into a directory selector. All of these key presses and menu options are customizable.

Pocket Term uses a customized [PocketJS checkout](https://github.com/chrispository/pocketjs); point your coding agent at it and ask it to build this repository. To connect, get your console's IP from ftpd, exit ftpd, then launch Pocket Term from Homebrew Launcher. With Pocket Term running on your 3DS, start the companion from this repository on your host computer:

```sh
bun run daemon --device <console-ip>
```

Keep the daemon running while you use Pocket Term. For full setup instructions, controls, and technical details, see the [original README](https://github.com/chrispository/pocket-term-omarchy/blob/c1ac365786df8610d5c4f0659d84d13464380702/README.md).

Pocket Term is MIT licensed; PocketJS, libghostty, and the bundled fonts have their own licenses. See the [font sources](assets/fonts/README.md) for font licenses and provenance.

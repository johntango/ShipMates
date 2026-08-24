# First Mate read-only plugin

This is a local Codex/ChatGPT plugin package for reading durable First Mate
workflow evidence. It intentionally exposes five read-only MCP tools only:

- current status;
- current design;
- current plan;
- candidate artifacts; and
- technical evidence.

It cannot approve, launch, pause, cancel, clean, wipe, edit files, access a
shell or Git, validate code, or publish work.

## Local development

The plugin is packaged with ShipMates and relies on the local checkout's
application service. Select the state directory explicitly; it will never
guess one:

```sh
SHIPMATES_STATE_DIR=/absolute/path/to/state npm run firstmate:mcp
```

The plugin's bundled CommonJS entrypoint delegates to that command. Installed
plugin caches do not preserve the plugin source's relationship to this
repository, so the launcher requires `SHIPMATES_REPOSITORY_ROOT` to identify
the checkout while `SHIPMATES_STATE_DIR` remains the independently configured
workflow data directory. It is for local development only and is not an HTTP
endpoint or a published plugin.

Run the package validation from the repository root:

```sh
python3 /Users/johnwilliams/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/firstmate-readonly
```

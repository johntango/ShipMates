# Herdr Codex integration backup

`herdr-agent-state-v6-fixed.sh` is the repaired Herdr Codex v6 hook. The repair
allows the hook to send both the session registration and agent-state reports.

If a Herdr update overwrites the installed hook, restore it with:

```sh
cp backups/herdr-agent-state-v6-fixed.sh ~/.codex/herdr-agent-state.sh
chmod +x ~/.codex/herdr-agent-state.sh
```

Then start a new Codex session inside Herdr.

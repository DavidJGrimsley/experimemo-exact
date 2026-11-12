# Quiet Exact checks on Windows

Run the web tests and verification without opening a separate console for the
Exact command:

```powershell
bun run test:quiet
bun run verify:quiet
```

These commands require Python 3 and Bun. The launcher also adds the current
user's Cargo bin directory and finds the standard Chrome installation when
they are available. It preserves the command's exit code and prints its output
when the command finishes. Other ways of invoking Exact do not use this
launcher, and external programs that explicitly open windows are outside its
control.

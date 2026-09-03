# 5. Working with the Vault

![Vault page](../images/vault.png)

## 5.1 Add & view

- **Add manually**: Vault → Add; give the key a name, paste the value, optionally add a note
- **Viewing**: keys are masked by default; the full value can be revealed on demand. Keys are stored encrypted (AES-256-GCM) under `~/.modelswap` on your machine
- **Command line**:

```bash
modelswap vault list                  # list all keys (masked)
modelswap vault set <key>             # store a key (interactive, recommended)
printf '%s' "$SECRET" | modelswap vault set <key> --stdin   # automation: keeps the secret out of shell history
modelswap vault get <key>             # print plaintext
modelswap vault delete <key>          # delete
```

## 5.2 Inject into the terminal

Expose selected keys as environment variables in the current terminal (use with `eval`):

```bash
eval "$(modelswap vault inject --keys OPENAI_API_KEY,OPENROUTER_KEY)"
modelswap vault inject --keys GEMINI_API_KEY --shell zsh   # shell format: bash/zsh/powershell
```

## 5.3 Auto-inject on cd (removed)

The `modelswap hook` commands were removed in v1.0.3; there is no cd-hook feature in current versions. To auto-inject keys per project, combine `modelswap vault inject` with your own shell tooling (direnv etc.) — ModelSwap itself **never** modifies your shell config (`~/.zshrc` / `~/.bashrc` etc.). See chapter 14's FAQ for cleaning up hooks installed by older versions.

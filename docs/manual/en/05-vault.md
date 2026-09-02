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

## 5.2 Project binding (auto-inject .env)

Keys can be bound to project directories — ModelSwap writes them into the project's `.env`:

1. Create a `.modelswapenv` file in the project root listing the key names you need, e.g. `OPENAI_API_KEY`
2. Run `modelswap vault env`; ModelSwap generates `.env` from `.modelswapenv` and registers the association
3. Run `modelswap vault sync` afterwards to refresh all associated files in one shot

```bash
modelswap vault where <key>           # which projects use a key
modelswap vault inject                # print export statements (use with eval)
modelswap vault inject --shell zsh    # shell format: bash/zsh/powershell
```

## 5.3 Auto-inject on cd (optional)

```bash
modelswap hook install               # cd hook: auto-export keys when entering a project
modelswap hook status                # check installation
modelswap hook uninstall             # remove
```

> **Shell config safety**: installing or upgrading ModelSwap **never** modifies your shell config (`~/.zshrc` / `~/.bashrc` etc.). Only an explicit `modelswap hook install` writes the cd hook, and `modelswap hook uninstall` removes it.

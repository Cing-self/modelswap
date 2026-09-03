# 14. CLI Cheat Sheet

```bash
modelswap                            # print help
modelswap web                        # start the web console (-p port / -o open browser)
modelswap upgrade                    # upgrade ModelSwap
modelswap -V                         # print version

# Vault
modelswap vault                      # list all keys (same as list)
modelswap vault set <key> [--stdin]  # store a key (--stdin keeps it out of shell history)
modelswap vault get <key>            # print plaintext
modelswap vault list [--json]        # list (--json for scripts/agents)
modelswap vault delete <key>         # delete
modelswap vault inject [--keys k1,k2] [--dir <dir>] [--shell zsh]   # print export statements
modelswap vault env [file] [--dir]   # generate .env from .modelswapenv and register the binding
modelswap vault where <key>          # which projects use a key
modelswap vault sync                 # refresh all associated files
modelswap vault test <platform>      # test a cloud sync platform connection
modelswap vault push                 # push keys & configs to the cloud
modelswap vault pull                 # pull and merge from the cloud

# Multi-machine sync
modelswap sync                          # status overview (--test also probes connections)
modelswap sync password                 # set the sync password (must match on every machine)
modelswap sync enable <platform>        # configure & enable a cloud platform (interactive, or --set KEY=VALUE)
modelswap sync test [platform]          # test connectivity
modelswap sync push / pull              # push / pull-and-merge
modelswap sync export                   # one-time sync code (platform config included; import on another machine)
modelswap sync pair --create            # LAN pairing: create a pairing code (requires modelswap web running)
modelswap sync pair --code <code>       # redeem the peer's connection code

# Providers / models
modelswap provider list [--json]     # list all providers
modelswap provider switch [agent]    # interactive switch
modelswap provider use <p> [--agent <a>] [--model <m>]   # non-interactive switch
modelswap provider add               # add a provider
modelswap provider delete <name>     # delete a provider
modelswap provider current [--json]  # current config of all agents
modelswap provider auth [--json]     # auth status

# Agent skill (let AI agents drive ModelSwap)
modelswap skill path                 # print the built-in skill file path
modelswap skill install [dir]        # install into a project's .agents/skills/modelswap
```

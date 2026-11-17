@AGENTS.md

Claude Code only: to verify UI work in the real window (see AGENTS.md), register the in-app server with `claude mcp add --transport http inklode-app http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"`, with the port given in `INKLODE_MCP_PORT`. The server answers 401 without the token; Settings > MCP server copies the whole line with it.
The headless server for one vault is `claude mcp add inklode -- /absolute/path/to/inklode/target/release/inklode-mcp --vault /absolute/path/to/vault`, after `cargo build --release -p inklode-mcp`. Point it at a throwaway vault.

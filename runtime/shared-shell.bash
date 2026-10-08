# Optional, per-shell routing. Desktop / VS Code and existing CLI binaries stay intact.
# Usage: source ~/.local/share/codex-web/current/bin/shared-shell.bash
codex() {
  case "${1:-}" in
    exec|e|review|login|logout|mcp|plugin|app-server|remote-control|completion|update|doctor|sandbox|debug|apply|a|queue|archive|delete|migrate-rollouts|unarchive|cloud|exec-server|features|help|agents)
      command codex "$@" ;;
    *) "$HOME/.local/bin/codex-shared" "$@" ;;
  esac
}

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Homes } from '@jevellan/core';

export const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
/** Temporary startup files load the owner's files; no native shell file is written. */
export function terminalShell(homes: Homes, sessionId: string, base: NodeJS.ProcessEnv = process.env) {
  const env = Object.fromEntries(Object.entries(base).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('JEVELLAN_')));
  env.HOME = homes.userHome; env.JEVELLAN_HOME = homes.root; env.TERM = 'xterm-256color'; env.COLORTERM = 'truecolor';
  const shell = base.SHELL && existsSync(base.SHELL) ? base.SHELL : process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
  const directory = homes.ensure('terminals', sessionId, 'shell');
  const save = (name: string, content: string) => { const file = join(directory, name); writeFileSync(file, content, { mode: 0o600 }); return file; };
  const original = base.ZDOTDIR || homes.userHome;
  if (basename(shell) === 'zsh') {
    for (const name of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) {
      save(name, `${name === '.zshenv' ? `export ZDOTDIR=${shellQuote(original)}` : 'export ZDOTDIR="$__jv_owner_zdotdir"'}\n[[ -f "$ZDOTDIR/${name}" ]] && source "$ZDOTDIR/${name}"\n__jv_owner_zdotdir="\${ZDOTDIR:-$HOME}"\nexport ZDOTDIR=${shellQuote(directory)}\n${name === '.zlogin' ? zshHooks : ''}`);
    }
    env.ZDOTDIR = directory;
    return { shell, args: ['-l'], env, directory, integrated: true };
  }
  if (basename(shell) === 'bash') {
    // Bash ignores --rcfile for a login shell. Load the normal login files explicitly before our interactive hooks.
    const startup = `[[ -f /etc/profile ]] && source /etc/profile\nfor __jv_profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do\n  if [[ -f "$__jv_profile" ]]; then source "$__jv_profile"; break; fi\ndone\nunset __jv_profile\n`;
    return { shell, args: ['--rcfile', save('bashrc', startup + bashHooks), '-i'], env, directory, integrated: true };
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return { shell, args: ['-l'], env, directory, integrated: false };
}

const zshHooks = `
HISTFILE=${shellQuote('/dev/null')}
unsetopt PROMPT_SP
autoload -Uz add-zsh-hook
__jv_preexec() {
  local __jv_encoded
  __jv_encoded=$(printf '%s' "$1" | command base64 | command tr -d '\\n')
  printf '\\033]133;C;%s\\007' "$__jv_encoded"
}
__jv_precmd() {
  local __jv_code=$?
  local __jv_cwd="\${PWD//\\%/%25}"
  __jv_cwd="\${__jv_cwd// /%20}"; __jv_cwd="\${__jv_cwd//\\#/%23}"; __jv_cwd="\${__jv_cwd//\\?/%3F}"
  printf '\\033]133;D;%s\\007\\033]7;file://localhost%s\\007\\033]133;A\\007' "$__jv_code" "$__jv_cwd"
}
add-zsh-hook preexec __jv_preexec
if (( $+functions[precmd] )); then functions[__jv_owner_precmd]="$functions[precmd]"; fi
precmd() { __jv_precmd; if (( $+functions[__jv_owner_precmd] )); then __jv_owner_precmd; fi; }
printf '\\033]133;P;1\\007'
PROMPT="$PROMPT"$'%{\\033]133;B\\007%}'
`;

const bashHooks = `
HISTFILE=/dev/null
HISTCONTROL=
HISTIGNORE=
shopt -s cmdhist lithist
__jv_in_command=0
__jv_in_hook=0
__jv_preexec() {
  [[ "$__jv_in_hook" == 1 || "$__jv_in_command" == 1 ]] && return
  [[ "$BASH_COMMAND" == '__jv_precmd'* || "$BASH_COMMAND" == '__jv_prompt'* ]] && return
  __jv_in_command=1
  local __jv_line __jv_encoded
  __jv_line=$(HISTTIMEFORMAT= builtin history 1)
  __jv_line="\${__jv_line#*[0-9]  }"
  __jv_encoded=$(printf '%s' "$__jv_line" | command base64 | command tr -d '\\n')
  printf '\\033]133;C;%s\\007' "$__jv_encoded"
}
__jv_precmd() {
  local __jv_code=$1
  __jv_in_hook=1
  local __jv_cwd="\${PWD//\\%/%25}"
  __jv_cwd="\${__jv_cwd// /%20}"; __jv_cwd="\${__jv_cwd//\\#/%23}"; __jv_cwd="\${__jv_cwd//\\?/%3F}"
  printf '\\033]133;D;%s\\007\\033]7;file://localhost%s\\007\\033]133;A\\007' "$__jv_code" "$__jv_cwd"
}
# Keep the owner's prompt command, then install the semantic hooks.
__jv_owner_prompt=("\${PROMPT_COMMAND[@]}")
__jv_prompt() {
  local __jv_code=$? __jv_part
  __jv_precmd "$__jv_code"
  for __jv_part in "\${__jv_owner_prompt[@]}"; do [[ -n "$__jv_part" ]] && eval "$__jv_part"; done
  __jv_in_command=0
  __jv_in_hook=0
}
PROMPT_COMMAND=__jv_prompt
PS1="$PS1"$'\\[\\033]133;B\\007\\]'
if bind -v 2>/dev/null | command grep -q 'enable-bracketed-paste'; then
  bind 'set enable-bracketed-paste on' 2>/dev/null
  printf '\\033]133;P;1\\007'
fi
trap '__jv_preexec' DEBUG
`;

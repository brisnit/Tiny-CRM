#!/bin/zsh
#
# Removes credential-bearing commands from shell history files.
#
#   zsh scripts/scrub-shell-history.zsh            # report only, changes nothing
#   zsh scripts/scrub-shell-history.zsh --apply    # rewrite the files
#
# ## What it matches
#
# Database connection strings that carry a password — `postgres://u:p@host`,
# `mysql://`, `mongodb://` — plus inline assignments of the variables this
# project uses for them. It matches on the SHAPE of a credential, never on a
# literal secret you supply, because a command containing the secret would
# itself land in history: cleaning up would be the thing that exposes it.
#
# ## What it will not do
#
# It never prints a matched line. Counts only. A tool that showed you what it
# was about to delete would reprint the credential into the scrollback you are
# trying to clean, and probably into a screenshot of it.
#
# It takes no backup. A backup is a second copy of the credential, written at
# the moment you decided one copy was too many. The rewrite is atomic — a temp
# file in the same directory, then a rename — so there is no window where the
# file is truncated.
#
# ## The ordering that actually matters
#
# With zsh's defaults, history is written when the shell EXITS. A shell that
# still holds the offending command in memory will append it again when you
# close it, after this script has run. So in that window, before closing it:
#
#     unset HISTFILE          # this shell will no longer write its history
#
# Then run this, then close the window. Doing it the other way round cleans
# the file and then refills it.

set -u
emulate -L zsh
setopt null_glob

local apply=0
[[ "${1:-}" == "--apply" ]] && apply=1

# Shapes of a credential, not any particular credential.
local -a PATTERNS=(
  'postgres(ql)?://[^[:space:]:/]+:[^[:space:]@]+@'   # postgres with a password
  'mysql://[^[:space:]:/]+:[^[:space:]@]+@'
  'mongodb(\+srv)?://[^[:space:]:/]+:[^[:space:]@]+@'
  '(DATABASE_URL|DIRECT_URL|ADMIN_DATABASE_URL|FIXTURE_DATABASE_URL)=[^[:space:]]*:[^[:space:]@]*@'
)
local joined="${(j:|:)PATTERNS}"

local -a FILES=(
  ~/.zsh_history
  ~/.bash_history
  ~/.psql_history
  ~/.node_repl_history
  ~/.zsh_sessions/*.history(N)
  ~/.zsh_sessions/*.historynew(N)
)

print ""
print "Shell history scrub — ${${apply:#1}:+report only}${${apply:#0}:+APPLYING}"
print "${(l:64::=:):-}"

local total=0 changed=0 f n
for f in $FILES; do
  [[ -f $f ]] || continue
  n=$(LC_ALL=C grep -cE "$joined" -- "$f" 2>/dev/null) || n=0
  total=$(( total + n ))
  printf "  %-46s %s match(es)\n" "${f/#$HOME/~}" "$n"
  (( n == 0 )) && continue
  (( apply == 0 )) && continue

  # Same directory, so the rename is atomic and never crosses a filesystem.
  local tmp="${f}.scrub.$$"
  umask 077
  if LC_ALL=C grep -vE "$joined" -- "$f" > "$tmp" 2>/dev/null; then
    # Preserve the original mode where we can; history files are 600 already.
    chmod --reference="$f" "$tmp" 2>/dev/null || chmod 600 "$tmp"
    mv -f "$tmp" "$f" && changed=$(( changed + 1 ))
  else
    rm -f "$tmp"
    print -u2 "  could not rewrite ${f/#$HOME/~} — left untouched"
  fi
done

print ""
if (( total == 0 )); then
  print "  Nothing matched. Note that with zsh's defaults a shell writes its"
  print "  history when it EXITS, so a window still holding the command has not"
  print "  written it yet. In that window: unset HISTFILE, then close it."
elif (( apply == 0 )); then
  print "  $total match(es). Nothing was changed. Re-run with --apply."
  print "  First, in any shell that ran the exposed command: unset HISTFILE"
else
  print "  Rewrote $changed file(s), removing $total line(s)."
  print "  Still to do by hand:"
  print "    - close any shell that ran the command (after: unset HISTFILE)"
  print "    - clear the scrollback of those windows"
  print "    - rotate the credential, which is the only step that truly ends it"
fi
print ""

# A multi-line command continues across lines in a history file; this removes
# the line carrying the credential and would leave its continuation behind.
# Rare for a one-line connection string, and worth knowing about.
print "  Note: multi-line history entries are matched line by line."
print ""

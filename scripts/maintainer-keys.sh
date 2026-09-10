# Allowed release-signing keys. The single source of truth; sourced (not run)
# by scripts/release-sign.sh and scripts/verify-maintainer-key.sh.
#
# One entry per line: <primary fingerprint, 40 hex, no spaces> <file under keys/> <uid email>
# Every fingerprint listed here must appear, in spaced form, in README.md,
# SECURITY.md, CONTRIBUTING.md and keys/README.md; CI checks that.
# To rotate or add a key: update this list, the key file, and those four
# documents together.
MAINTAINER_KEYS='
D288E78408C20FA64DA6C0E6403E5FAF3E494185 rich-henderson.asc rich@musqet.tech
0846EDC0041B695E8CB794A099F1B93403D14A70 ben-de-waal.asc ben@musqet.tech
'

# Helpers. POSIX sh; no arrays.
maintainer_fprs() { printf '%s\n' "$MAINTAINER_KEYS" | awk 'NF{print $1}'; }
maintainer_files() { printf '%s\n' "$MAINTAINER_KEYS" | awk 'NF{print $2}'; }
maintainer_file_for() { printf '%s\n' "$MAINTAINER_KEYS" | awk -v f="$1" '$1==f{print $2}'; }
maintainer_email_for() { printf '%s\n' "$MAINTAINER_KEYS" | awk -v f="$1" '$1==f{print $3}'; }
is_maintainer_fpr() { maintainer_fprs | grep -q -x -F "$1"; }
# Spaced form as printed in the documents: groups of four.
spaced_fpr() { printf '%s' "$1" | sed 's/\(....\)/\1 /g; s/ $//'; }

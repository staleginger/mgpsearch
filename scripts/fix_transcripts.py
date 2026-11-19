#!/usr/bin/env python3
"""Apply transcription corrections to all transcripts in output/.

Corrections live in scripts/corrections.json as a JSON object mapping a
correct phrase to a list of its misspellings:
{"music görning podcaster": ["music journal", "music journalist podcaster"]}.
Enter the misspellings in lowercase (they are normalized on load). Matching
is whole-phrase only: a misspelling must stand alone, so it is never fixed
inside a larger word or phrase ("Music Journalist Podcast-studion" is left
alone by "music journalist podcast"). The matched occurrence is replaced
with the correct phrase, mirroring the case of the match word for word:
"Music Journalist Podcaster" -> "Music Görning Podcaster",
"MUSIC JOURNAL" -> "MUSIC GÖRNING PODCASTER",
"Music Journals podcast" -> "Music Görning podcaster". Punctuation does not
block a match ("Music Journal!" is fixed). Cases mixed inside a word are
left alone.

A special top-level key "_substitutions" holds a JSON object mapping a
literal string to the literal string it should become, e.g.
{"&amp;": "&"}. Unlike phrase rules these are plain substring replacements:
every occurrence is replaced regardless of surrounding characters, so they
fix symbols leaked from HTML escaping that are embedded in a larger word
("R&amp;B" -> "R&B"). Substitutions are applied after the phrase rules,
longest source first, in every output/*.md file (except index.md).

Each file is corrected to a fixpoint: phrase rules and substitutions run
in passes over it until a pass changes nothing, so rules that create
matches for other rules converge in a single run (e.g. "&nbsp;" -> " "
exposing a phrase variant, or a double-escaped "&amp;lt;" peeling down to
"<"). A pass cap (MAX_PASSES) guards against accidental rule cycles; a
file still changing at the cap is written as-is and flagged on stderr.

If anything changed, the changed files are committed (NOT pushed) with a
message listing each correction and its amount.

Usage: python3 scripts/fix_transcripts.py
"""

import json
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "output"
CORRECTIONS = Path(__file__).resolve().parent / "corrections.json"
SKIP = {"index.md"}
STYLES = (str.lower, str.capitalize, str.upper)
SUB_KEY = "_substitutions"  # reserved key: literal -> literal replacements
MAX_PASSES = 10  # fixpoint pass cap per file; guards against rule cycles


def build_rule(variant: str, correct: str) -> tuple[re.Pattern, object]:
    """Compile variant->correct as one regex covering all case forms.

    variant/correct are lowercase. Each word of the match may be in its
    lowercase, capitalized or ALL-CAPS form (any combination, e.g.
    "Music Journals podcast"); the replacement mirrors the matched case
    word for word, and a word of the correct phrase without a counterpart
    in the match takes the case of the last matched word, so "MUSIC
    JOURNAL" becomes "MUSIC GÖRNING PODCASTER". A match must stand alone:
    the characters directly before/after it (if any) may not be letters,
    digits, underscores or hyphens, so a misspelling only ever matches the
    complete phrase it names, never part of a larger one.
    """
    vwords = variant.split()
    cwords = correct.split()
    groups = []
    for w in vwords:
        alts = "|".join(re.escape(s(w)) for s in STYLES)
        groups.append(f"({alts})")
    rx = re.compile(r"(?<![\w-])" + " ".join(groups) + r"(?![\w-])")

    def repl(m):
        # the match took one of the three forms per word; if two forms are
        # identical (e.g. one-letter words), the earlier form wins, exactly
        # as the first matching case combination of the old implementation
        sty = []
        for i, mw in enumerate(m.groups()):
            w = vwords[i]
            sty.append(next(s for s in STYLES if mw == s(w)))
        return " ".join((sty[i] if i < len(sty) else sty[-1])(w)
                        for i, w in enumerate(cwords))

    return rx, repl


def main() -> int:
    try:
        data = json.loads(CORRECTIONS.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"cannot read {CORRECTIONS.name}: {e}", file=sys.stderr)
        return 1
    if not isinstance(data, dict):
        print(f"{CORRECTIONS.name} must be a JSON object", file=sys.stderr)
        return 1
    # separate the reserved literal-replacement section, if present
    subs_raw = data.pop(SUB_KEY, {})
    if not isinstance(subs_raw, dict) or not all(
        isinstance(k, str) and isinstance(v, str) and k
        for k, v in subs_raw.items()
    ):
        print(f'{CORRECTIONS.name}["{SUB_KEY}"] must be a JSON object of '
              f'"source": "replacement"', file=sys.stderr)
        return 1
    if not all(
        isinstance(k, str) and isinstance(v, list) and v
        and all(isinstance(x, str) for x in v)
        for k, v in data.items()
    ):
        print(f'{CORRECTIONS.name} must be a JSON object of '
              f'"correct phrase": ["misspelling", ...]', file=sys.stderr)
        return 1
    rules = sorted(  # (misspelling, correct phrase), longest misspelling first
        ((v.lower(), k) for k, vs in data.items() for v in vs),
        key=lambda vc: len(vc[0]), reverse=True,
    )
    variants = [v for v, _ in rules]
    compiled = [build_rule(v, c) for v, c in rules]
    # literal replacements, longest source first so a shorter source can
    # never partially consume a longer one
    subs = sorted(subs_raw.items(), key=lambda kv: len(kv[0]), reverse=True)
    # one pass per file finds which variants occur at all; variants are
    # longest first (as in rules), so a shorter variant can never shadow
    # a longer one that has it as a prefix
    present_rx = (re.compile("|".join(re.escape(v) for v in variants))
                  if variants else None)
    files = [p for p in sorted(OUT.glob("*.md")) if p.name not in SKIP]
    tty = sys.stdout.isatty()
    t0 = time.monotonic()
    totals = {}   # variant -> total replacements across all files and passes
    sub_totals = {}  # substitution source -> total replacements across files
    changed = []

    def apply_pass(text: str) -> str:
        """One pass: phrase rules, then literal substitutions.

        The pre-filter is computed on the text as it starts the pass, so a
        rule that only becomes applicable after another rule ran in a later
        stage is picked up on the next pass.
        """
        new = text
        if present_rx is not None:
            present = {m.group(0) for m in present_rx.finditer(new.casefold())}
            for (variant, _), (rx, repl) in zip(rules, compiled):
                if variant in present:  # cheap pre-filter: skip absent variants
                    new, n = rx.subn(repl, new)
                    if n:
                        totals[variant] = totals.get(variant, 0) + n
        for src, dst in subs:
            if src in new:  # plain substring replacement, longest source first
                sub_totals[src] = sub_totals.get(src, 0) + new.count(src)
                new = new.replace(src, dst)
        return new

    for i, path in enumerate(files, 1):
        old = path.read_text(encoding="utf-8")
        new = old
        for _ in range(1, MAX_PASSES + 1):
            new2 = apply_pass(new)
            if new2 == new:
                break  # fixpoint reached
            new = new2
        else:  # no pass was no-op: the cap was hit
            print(f"  {path.name}: still changing after {MAX_PASSES} passes; "
                  f"check for a rule cycle", file=sys.stderr)
        if new != old:
            path.write_text(new, encoding="utf-8")
            changed.append(path.name)
        if tty:
            sys.stdout.write(f"\r  [{i}/{len(files)}] {path.name}")
            sys.stdout.flush()
        elif i % 50 == 0 or i == len(files):
            print(f"  [{i}/{len(files)}] {path.name}")
    if tty:
        sys.stdout.write("\r" + " " * 42 + "\r")
        sys.stdout.flush()
    print(f"scanned {len(files)} file(s) in {time.monotonic() - t0:.1f}s")

    if not changed:
        print("nothing to fix")
        return 0

    correct_of = dict(rules)
    for variant, correct in rules:
        if variant in totals:
            print(f"  {variant} -> {correct} ({totals[variant]})")
    for src, dst in subs:
        if src in sub_totals:
            print(f"  {src} -> {dst!r} ({sub_totals[src]})")
    print(f"{len(changed)} file(s) changed: {', '.join(changed)}")

    msg = "Applicerar automatiska rättelser\n\n" + "".join(
        f"- {v} -> {correct_of[v]} ({n})\n" for v, n in totals.items()
    ) + "".join(
        f"- {src} -> {dst} ({n})\n" for src, n in sub_totals.items()
    )
    paths = [f"output/{name}" for name in changed]
    try:
        subprocess.run(["git", "add", "--", *paths], cwd=ROOT, check=True)
        subprocess.run(["git", "commit", "-m", msg, "--", *paths], cwd=ROOT, check=True)
    except subprocess.CalledProcessError as e:
        print(f"git failed (exit {e.returncode}); files were modified but not committed", file=sys.stderr)
        return 1
    print("committed (not pushed)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

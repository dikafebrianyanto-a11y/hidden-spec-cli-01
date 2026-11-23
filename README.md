# hidden-spec-cli-01

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dikafebrianyanto-a11y/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dikafebrianyanto-a11y/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend`: one command-line tool that applies the edits AI models write, in four formats, to a tree of files. `SPEC.md` is the whole specification.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the path of the patch file, or `-` (or absent) to read it from standard input. `--format=unified|search-replace|v4a|json|auto` picks the format (default `auto`), `--check` does everything but write, `--strict` matches lines exactly.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone. It implements all of SPEC.md: the command line, output and exit codes, safe paths, format detection, line matching at three tiers, unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON edits and the all-or-nothing write. Its last lines hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: the kit's runner, kept as it is. In a trial it reads the checks from the env, runs `node main.ts` on each one in a fresh directory, and posts what main.ts did.
- `check.ts`: the practice set on your own machine:

      node check.ts ../program/generator/practice.json

  It prints every check main.ts gets wrong, with what differed, and the practice score. This entry scores 1000 on the practice set (100 of 100 checks) and passes 50 extra edge-case tests written from SPEC.md sentences the practice set does not show.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

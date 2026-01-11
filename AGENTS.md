# Agent Instructions

## Issue Tracking

This project uses **bd (beads)** for issue tracking.
Run `bd prime` for workflow context, or install hooks (`bd hooks install`) for auto-injection.

**Quick reference:**
- `bd ready` - Find unblocked work
- `bd create "Title" --type task --priority 2` - Create issue
- `bd close <id>` - Complete work
- `bd sync` - Sync with git (run at session end)
- `bd update <id> --status=in_progress`

For full workflow details: `bd prime`.

## Requirements and Design

Start at the highest level, with a plan for a maintainable, operable, and performant system built by an unreliable team of LLMs. Use an iterative approach, asking the user for adjustments before each next level of the SDLC.

Be very concise, your user is a highly-experienced principal engineer.

Whenever you need to make a decision about how to implement something or whether to take a shortcut, lay out an appropriate number of options with pros and cons and then recommend a choice to the user. Assume that the problem is underspecified and incorrect assumptions will result in a lot of wasted work.

## Development

After each iteration, measure test coverage, simplify the code and tests, and update the roadmap as well as AGENTS.md or the relevant subdoc (e.g. when writing tests, update [docs/TESTS.md](docs/TESTS.md))

When writing or adjusting code or tests, see [docs/TESTS.md](docs/TESTS.md).

Run `./verify` to test and lint before completing an iteration.

Development iteration speed is important, so keep everything organized by related functionality, not file types or anything else weird. Iteration speed is important, so the tests must run fast.

Git commit after each set of changes.

When you need code from github, use ssh / git@github.com submodules.

Reference sitemap.html to see what UI is available (and keep it up to date). Similarly, reference roadmap.md, add tasks to it before starting work, and tick things off (and add them to changelog.md) as they are completed. 

## Deployment / Operations

Check staging logs: `./logs` (or `./logs -f` to follow, `./logs "error|exception"` to filter)

The user must be able to trust the tests to deploy a release.

## Coder Reponsibilities

to avoid putting too much weight on reviewers, coders must:

1. Code must follow agreed upon styles and conventions and be adequately tested
1. The contributor understands and stands by their pull request, accepting to the best of their knowledge that the change is correct, and relevant issues and tradeoffs have been adequately considered
1. The contributor has provided adequate context for the change for the reviewer, their colleagues, and their future selves
1. The contributor approaches the review with an open mind, expecting potentially extensive feedback and rework, especially when AI is involved
1. The contributor understands the complex tradeoff between short-term gain and long-term tech debt when it comes to making any changes in the codebase


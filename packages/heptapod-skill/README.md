# Heptapod skill

The shared Heptapod agent skill for Codex and Claude Code.

- Codex: install the `packages/heptapod-skill/skills/heptapod` directory from the GitHub repository.
- Claude Code: install the `heptapod` plugin from this repository's `heptapod` marketplace.

The skill invokes a repository-local installation of `@thestraylight/heptapod` through `pnpm exec`. The skill directs the calling agent to run tests itself and submit tree-bound evidence. The CLI performs repository-local capture, patch/evidence validation, and structural diff generation, then uploads the result to the separately installed global Heptapod service.

Install this package in the target repository, then create the project-local Codex and Claude skill links:

```sh
pnpm add --save-dev @thestraylight/heptapod-skill
pnpm exec heptapod-skill install
```

Install the persistent site once per machine:

```sh
pnpm add --global @thestraylight/heptapod
heptapod service install
```

This links the packaged skill into `.agents/skills/heptapod` for Codex and `.claude/skills/heptapod` for Claude. Use `heptapod-skill status` to inspect the links or `heptapod-skill uninstall` to remove only links owned by this package.

Most substantive steps include Excalidraw diagrams exported with `heptapod diagram`, explaining architecture, sequences, entity relationships, or algorithms at a high level.

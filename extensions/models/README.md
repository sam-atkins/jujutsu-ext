# @dismal_swamper/jujutsu

Publishes working-copy changes from a jj (jujutsu) repository: describes the
working-copy commit with a message, starts a fresh working copy, and pushes the
described commit to the default remote with a change-based bookmark.

## Usage

Create a model definition, optionally pointing it at the jj repository with the
`workingDirectory` global argument (defaults to the current working directory):

```bash
swamp model create @dismal_swamper/jujutsu my-jj-publish \
  --global-arg workingDirectory=/Users/sam/code/my-project
```

Run the `publish` method with a commit description:

```bash
swamp model method run my-jj-publish publish \
  --input message="chore: bump deps"
```

If the working copy has no changes, the method skips cleanly and reports
success with `pushed: false` — nothing is described, committed, or pushed. On
any failure, a failure record is written to the `result` resource before the
method throws.

## Output

The `result` resource has `command`, `exitCode`, `success`, `pushed`,
`description`, and `bookmark` fields. `bookmark` is the change-based bookmark
created by the push (e.g. `sam/abc123/chore-bump-deps`), or empty when nothing
was pushed.

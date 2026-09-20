---
name: dependency-security-fix
description: Remediate one npm dependency vulnerability in an existing isolated worktree. Use when an orchestrator supplies the package, target version, manifest, alert, and required validation after the deterministic package bump has run.
---

# Dependency Security Fix

Work only inside the supplied worktree. Preserve the requested dependency version and do not create, push, close, or merge pull requests.

1. Inspect the changed manifest and lockfile plus the dependency analysis supplied in the prompt.
2. Find application code, configuration, and tests affected by the dependency upgrade.
3. Make only compatibility changes required by the upgrade. Do not broaden the task or upgrade unrelated packages.
4. Run the narrowest relevant existing tests, then the repository's standard validation when practical.
5. Inspect the final diff. Do not commit; the orchestrator owns staging and commits.
6. Return a concise summary of changed files, validations run, failures, and residual risks.

Stop without making speculative changes when the package bump is already sufficient. Never weaken tests, suppress security checks, expose credentials, or modify files outside the worktree.

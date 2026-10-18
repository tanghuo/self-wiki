# Vendored chatgpt-imagegen

Source: https://github.com/leeguooooo/chatgpt-imagegen

The exact commit and original SHA-256 are recorded in `upstream.json`. The extensionless Python script is unmodified and distributed with its MIT license.

Self Wiki calls only `run_web` through `../../chatgptWeb.py`. The adapter supplies browser configuration, UTF-8 process handling, cancellation checks, the actual submitted prompt, and strict confirmation that all reference images were attached. It uses an explicitly configured Chrome profile or extension relay without scanning cookie databases, keeps generated conversations, and does not invoke upstream's auto-update, style library, Codex OAuth, or provider fallback paths.

The normal Codex CLI image path remains owned by Self Wiki's existing app-server integration. To update this dependency, pin a new commit, replace the source and license, update the recorded digest, and rerun the web executor integration tests before a real browser smoke test.

The host requests chrome-use JSON explicitly and decodes the modern `data.result` envelope as well as legacy eval values. It captures subprocess output with temporary files so a daemon inheriting stdout on Windows cannot block the caller waiting for EOF. Submission is confirmed by observing the matching user message in the page; an unconfirmed submission or terminal page-load failure stops the operation instead of entering the long image polling loop.

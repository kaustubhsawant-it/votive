# Contributing to Votive

Thanks for looking. This is a small, one-person project, so the best contributions are bug reports with the details
asked for in the issue form, and small, focused pull requests.

## Before you start
Open an issue first for anything bigger than a fix, so we agree on it before you spend time. Votive keeps two promises
that shape what can be added:

- **Nothing leaves your Mac.** No networking code anywhere in the app, the hooks or the MCP server. A test
  (`tests/no-network.test.js`) fails if any appears.
- **Everything it reads, writes and runs is listed** in [PRIVACY.md](PRIVACY.md). A new write or a new program it runs
  has to be added there too; tests (`tests/privacy-manifest.test.js`) fail when the page stops being true.

## Build and test
```sh
brew install xcodegen node
git clone https://github.com/kaustubhsawant-it/votive.git && cd votive
xcodegen generate
xcodebuild -project Votive.xcodeproj -scheme Votive -configuration Debug build
node --test tests/*.test.js
```
More in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The Swift logic is
tested by compiling it with `swiftc` inside the Node tests, so a Mac with Xcode tools is needed for the full run.

## Pull requests
- Keep one change per pull request and say what you ran. Tests should pass.
- Match the surrounding code: its comment density, naming and style.
- Update `CHANGELOG.md` under "Unreleased", and the docs if behavior changes.
- No new dependencies without a reason in the pull request.

## Security
Please report security problems privately: see [SECURITY.md](SECURITY.md).

## Licence
By contributing you agree that your contribution is released under the project's [MIT license](LICENSE).

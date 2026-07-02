# Streaming Scope Pack

Read-only viewer for the two-option streaming platform scoping pack: user stories with Gherkin acceptance criteria (Option A and Option B), plus the assumptions and open questions register.

## Run locally

No build step and no dependencies to install. Open `index.html` directly in a browser, or serve the folder statically:

```
python -m http.server 4321
```

## Regenerate the data

Story content lives in `data.js`, generated from the source markdown docs by:

```
node build.js [--src <path-to-docs-folder>]
```

The default source path is `../Streaming/docs` relative to this folder. The script validates structure and counts, and fails loudly if the source format drifts; expected counts live in the `EXPECTED` constant at the top of `build.js`.

## Wireframes

`wireframes.js` holds lo-fi SVG wireframes (`window.SCOPE_WIREFRAMES`), each tagged to epics and story IDs, with numbered callout badges keyed to acceptance-criteria scenarios. They are authored artifacts (not generated from the docs); `node build.js` validates them against the story data: every referenced story and scenario name must exist, callout badges must be present in the primary variant, and SVGs must pass safety rules (no scripts, no external references). All wireframes are illustrative, not visual design.

## Hosting

Served as a static site from the `main` branch via GitHub Pages. `.nojekyll` disables Jekyll processing. All routes are hash-based, so no SPA rewrite rules are needed.

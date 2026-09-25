# Jevellan website

The public website lives at <https://gongiskhan.github.io/jevellan/>.
English is at `/jevellan/`; Portuguese is at `/jevellan/pt/`.

This is a static site: HTML, CSS, JavaScript, SVG and locally hosted fonts.
There is no build step or external runtime dependency. Font licenses are in
`assets/fonts/OFL.txt`. The interactive app tour uses illustrative data and
does not connect to a running Jevellan instance.

GitHub Pages uses the **GitHub Actions** source. `.github/workflows/pages.yml`
publishes only this directory when it changes on `main`, or when manually run.
Relative links support the repository's `/jevellan/` prefix. Keep that prefix
in canonical, social preview and language-alternate URLs.

For a local preview, run `python3 -m http.server 9784 --directory site` from
the repository root, then open <http://localhost:9784/>. Check both languages,
both themes, the mobile menu and the interactive demos after changing assets.

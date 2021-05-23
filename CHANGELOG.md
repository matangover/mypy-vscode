# Change Log

## 0.2.0

- The extension no longer uses `mypyls` (the mypy language server). We now use the mypy daemon (`dmypy`) which is built into mypy. This leads to less maintenance burden, full mypy feature support, and easier installation.

- The `mypy.executable` setting is now deprecated (because it used to point to mypyls which is no longer used). Use the new `mypy.dmypyExecutable` instead (which points to dmypy). The extension will attempt to migrate your settings automatically if needed.

- Added support for multiple workspace folders. A separate mypy daemon will be launched for each workspace folder. All configuration settings can be set on a per-folder basis if desired.

- Added the option `mypy.runUsingActiveInterpreter` to run dmypy using the interpreter that is currently selected in the Python extension. Can be useful if you install a specific version of mypy in each project. However, normally this is not needed (your code is always checked against the active interpreter anyway).

- The extension no longer overrides mypy's `check_untyped_defs` setting to true. This means that code inside unannotated functions will no longer be checked by default. If you want the old behavior, create a `mypy.ini` file with the following contents:
  ```
  [mypy]
  check_untyped_defs=true
  ```

- Support the new interpreter storage in the Python extension (experimental replacement for the `python.pythonPath` setting).

- Support more mypy config file options, e.g. `files` and `strict` (in mypyls these options were not supported).
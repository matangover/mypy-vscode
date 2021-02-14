# Change Log

## 0.2.0

- The extension no longer uses `mypyls` (the mypy language server). We now use the officially supported mypy daemon (`dmypy`).

- The `mypy.executable` setting is now deprecated (because it used to point to mypyls which is no longer used). Use the new `mypy.dmypyExecutable` instead (which points to dmypy). The extension will attempt to migrate your settings automatically if needed.

- Added support for multiple workspace folders. A separate mypy daemon will be launched for each folder. All configuration settings can be set on a per-folder basis if desired.

- Added the option `mypy.runUsingActiveInterpreter` to run dmypy using the selected interpreter. Can be useful if you install a specific version of mypy in each project.

- You might notice a `.dmypy.json` file in the workspace folder. This is the mypy daemon status file, you can ignore it.

- The extension no longer sets mypy's `check_untyped_defs` setting to true. If you want the old behavior,
  create a `mypy.ini` file with the following contents:
  ```
  [mypy]
  check_untyped_defs=true
  ```

- Support the new interpreter storage in the Python extension (replacement for the `python.pythonPath` setting).

- Support more mypy config file options, e.g. `files` and `strict` (due to using dmypy directly instead of mypyls).
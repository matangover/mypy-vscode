# Mypy extension for VS Code
Runs mypy on Python code to provide type checking.

* Runs on your entire workspace. (This is different from Microsoft's Python extension's mypy functionality which only lints each file separately, leading to incomplete type checking.)

* Uses the [mypy daemon](https://mypy.readthedocs.io/en/latest/mypy_daemon.html) to keep the analysis state in memory so that only changed files are rechecked.

* Respects the active Python interpreter (set in the Python extension) and the `mypy.ini` configuration file.

* Supports multi-root workspaces: will launch a separate mypy daemon for each workspace folder.

## Installing mypy

This extension requires mypy to be installed on your system. To install mypy, run `pip install mypy`. There are other ways to install mypy, such as using `pipx` or your system's package manager.

By default, this extension relies on having the `dmypy` executable available on your PATH. This should be the case
if you installed mypy globally. To use a different mypy installation, set the `mypy.dmypyExecutable` setting.

Some people prefer to have mypy installed in each project's virtual environment rather than in a global location. To do this, enable `mypy.runUsingActiveInterpreter`.

## Configuration

To configure mypy, you can create a `mypy.ini` file in your workspace folder (or any of the default locations). See [mypy configuration file](https://mypy.readthedocs.io/en/stable/config_file.html). You can also specify a custom path to `mypy.ini` using the `mypy.configFile` setting.

Use the `mypy.targets` setting to specify a list of target files or folders for mypy to analyze. By default the entire workspace folder is checked. You may prefer to use the `files` option in `mypy.ini` to specify which files mypy should analyze. In that case, you should set `mypy.targets` to an empty array (`[]`).

## Note for users upgrading from an older version

Previously, this extension used `mypyls` (the [Mypy Language Server](https://github.com/matangover/mypyls/)). However, this is no longer the case: the extension now uses the mypy daemon directly. See the [change log](https://github.com/matangover/mypy-vscode/blob/master/CHANGELOG.md) for details. If you have previously installed `mypyls`, the extension will continue to use mypy from that same installation. If you want, you can uninstall mypyls and install mypy separately.

Also, in previous versions this extension automatically enabled mypy's `check_untyped_defs` setting by default (see [documentatation](https://mypy.readthedocs.io/en/stable/config_file.html#confval-check_untyped_defs)). However, for consistency with mypy's defaults, the extension no longer does this. To re-enable this option, use the mypy config file.

## License

This project is made available under the MIT License.

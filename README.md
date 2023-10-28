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

Some people prefer to have mypy installed in each project's virtual environment rather than in a global location. To do this, enable `mypy.runUsingActiveInterpreter` (either globally or for a specific workspace).

## Configuration

To configure mypy, you can create a `mypy.ini` file in your workspace folder (or any of the default locations). See [mypy configuration file](https://mypy.readthedocs.io/en/stable/config_file.html). You can also specify a custom path to `mypy.ini` using the `mypy.configFile` setting.

To configure the mypy-vscode extension, use the following VS Code settings:

* `mypy.targets`: specify a list of target files or folders for mypy to analyze. By default the entire workspace folder is checked. You may prefer to use the `files` option in `mypy.ini` to specify which files mypy should analyze. In that case, you should set `mypy.targets` to an empty array (`[]`).

* `mypy.dmypyExecutable`: Path to `dmypy` (the mypy daemon). Either a full path or just a name (which must exist in your PATH). You can use substitutions: `${workspaceFolder}` and `~` (home directory).

* `mypy.runUsingActiveInterpreter`: Use the active Python interpreter (selected in the Python extension) to run dmypy itself, instead of the `mypy.dmypyExecutable` setting. Note: your code is always checked against the active interpreter – this setting only controls the interpreter used to run dmypy itself.

* `mypy.configFile`: Mypy config file, relative to the workspace folder. If empty, search in the default locations. See https://mypy.readthedocs.io/en/latest/config_file.html.

* `mypy.extraArguments`: A list of extra command-line arguments to append to the `dmypy run` command. For a list of options, see [mypy's documentation](https://mypy.readthedocs.io/en/stable/command_line.html).

* `mypy.enabled`: Enable or disable Mypy checking. For example, you can disable Mypy for a specific workspace or folder.

* `mypy.debugLogging`: Enable debug logging for the extension. (Reload the window after changing this setting.)

## License

This project is made available under the MIT License.

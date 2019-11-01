# Mypy extension for VS Code
Runs mypy on Python code to provide type checking.

* Runs on your entire workspace folder. (This is different from Microsoft's Python extension's mypy functionality which only lints each file separately, leading to incomplete type checking.)

* Embeds the [mypy daemon](https://mypy.readthedocs.io/en/latest/mypy_daemon.html) and keeps the analysis state in memory so that only changed files are rechecked.

* Respects your `pythonPath` and `mypy.ini`. You may override the default configuration.

Please report any bugs. See caveats below.

## Installation

Python 3.7 or later must be installed to run the mypy language server (for your own code you can use any Python version).

1. Create a virtualenv and install the mypy language server in it:

   On macOS or Linux:

    ```shell
    $ python -m venv ~/.mypyls
    $ ~/.mypyls/bin/pip install "https://github.com/matangover/mypyls/archive/master.zip#egg=mypyls[default-mypy]"
    ```

    On Windows:
    
    ```shell
    $ python -m venv %USERPROFILE%\.mypyls
    $ %USERPROFILE%\.mypyls\Scripts\pip install "https://github.com/matangover/mypyls/archive/master.zip#egg=mypyls[default-mypy]"
    ```

2. Install the mypy extension in VS Code (or reload the window if the extension is already installed).

### Installation in non-default location

If you installed the mypy language server in a location other than `~/.mypyls/bin/mypyls` (or `%USERPROFILE%\.mypyls\Scripts\mypyls.exe` on Windows), specify that location in your user settings in VS Code (`mypy.executable`).

## Updating

If you update the mypy-vscode extension, you may also need to update the mypy language server separately. Do so by running the following command (assuming you used the default installation paths given above).

On macOS or Linux:

```shell
$ ~/.mypyls/bin/pip install -U "https://github.com/matangover/mypyls/archive/master.zip#egg=mypyls"
```

On Windows:

```shell
$ %USERPROFILE%\.mypyls\Scripts\pip install -U "https://github.com/matangover/mypyls/archive/master.zip#egg=mypyls"
```

## Configuration

The extension loads your `mypy.ini` configuration (if any) from the workspace folder or any of the default locations. See [mypy configuration file](https://mypy.readthedocs.io/en/stable/config_file.html). You can specify a custom path to `mypy.ini` using the `mypy.configFile` setting.

Use the `mypy.targets` setting to specify a list of target files or folders for mypy to analyze. By default the entire workspace folder is checked. Note that mypy does not recurse into folders without an `__init__.py`.

## Experimental: Installation with extra features

The plugin also provides experimental support for hover and go-to-definition features using mypy's code analysis engine. These features require Python 3.8 and a patched version of mypy. Python 3.8 is only required to run the language server – for your own code you can use any Python version.

To try these features, use the following installation steps instead of the ones given above.

1. Create a Python 3.8 virtualenv and install the mypy language server in it, with a patched version of mypy:

   On macOS or Linux:

    ```shell
    $ python3.8 -m venv ~/.mypyls
    $ ~/.mypyls/bin/pip install "https://github.com/matangover/mypyls/archive/master.zip#egg=mypyls[patched-mypy]"
    ```

   On Windows:
   ```shell
    $ python3.8 -m venv %USERPROFILE%\.mypyls
    $ %USERPROFILE%\.mypyls\Scripts\pip install "https://github.com/matangover/mypyls/archive/master.zip#egg=mypyls[patched-mypy]"
    ```

2. Install the mypy extension in VS Code (or reload the window if the extension is already installed).


## Caveats

* Uses mypy as a library - this is not supported by the mypy team. This means that future mypy updates may take time to integrate into this extension.
* Tested on macOS only, but should be cross platform.
* Tested on Python 3.7 and Python 3.8.
* Cannot yet analyze unsaved files.
* Mypy bails on first syntax error encountered.
* When you make configuration changes you must reload the VS Code window.
* Multi-root workspaces not supported for now. Only the first workspace folder is checked.
* Documentation is not displayed in hovers. This will probably not be fixed because mypy does not collect this information.
* Hovers and go to definition work only on typechecked code. By default we set `check_untyped_defs` to True, so all code should be analyzed.

## Mypy Language Server
The interesting bits of this extension are actually implemented in the [Mypy Language Server](https://github.com/matangover/mypyls/).

## License

This project is made available under the MIT License.
The language server is based on Palantir's [python-language-server](https://github.com/palantir/python-language-server) and uses [mypy](https://github.com/python/mypy).

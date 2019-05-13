# Mypy extension for VS Code
Runs mypy on Python code to provide type checking, go to definition, and hover.

## Installation

### Basic installation (type checking only)

Requires Python 3.5 or later.

1. Create a virtualenv and install the mypy language server in it:

    ```shell
    $ python -m venv ~/.mypyls
    $ ~/.mypyls/bin/pip install "https://github.com/matangover/mypyls/archive/master.zip#egg=mypyls[default-mypy]"
    ```

2. Install the mypy extension in VS Code (or reload the window if the extension is already installed).

### Installation with hover and go to definition

These features require Python 3.8 (currently in pre-release) and a patched version of mypy.

1. Install [Python 3.8 pre-release](https://www.python.org/download/pre-releases/) (you may choose to use [pyenv](https://github.com/pyenv/pyenv)).
2. Create a Python 3.8 virtualenv and install the mypy language server in it:
    ```shell
    $ python3.8 -m venv ~/.mypyls
    $ ~/.mypyls/bin/pip install "https://github.com/matangover/mypyls/archive/master.zip#egg=mypyls[patched-mypy]"
    ```
3. Install the mypy extension in VS Code (or reload the window if the extension is already installed).

### Installation in non-default location

If you installed the mypy language server in a location other than `~/.mypyls/bin/mypyls`, specify that location in your user settings in VS Code (`mypy.executable`).

## Configuration

TBD

## Development

TBD

## License

This project is made available under the MIT License.
The language server is based on Palantir's [python-language-server](https://github.com/palantir/python-language-server) and uses [mypy](https://github.com/python/mypy).
# Change Log

## 0.2.0

- The extension no longer uses mypyls (the mypy language server). We now use the officially supported mypy daemon (dmypy).
  If you had previously changed the mypy.executable setting (which pointed to mypyls),
  please use the new mypy.dmypyExecutable instead (which points to dmypy).

import builtins
import machine
import os
import time

import cdcaux
import ide_display
from ide_files import is_directory


class IDEStop(BaseException):
    pass


def stop(_=None):
    raise IDEStop


def error(title, message):
    ide_display.error(title, message)
    raise IDEStop


def _run_file(path):
    with open(path, "r") as f:
        code = compile(f.read(), path, "exec")
    scope = {"__name__": "__main__", "__file__": path}
    try:
        exec(code, scope)
        update = scope.get("update")
        if callable(update):
            run(update)
    except Exception as e:  # noqa: BLE001
        fatal_error("Error!", e)


def execute(path, debug=False):
    builtins.ide_mode = True
    if debug:
        import ide_debug
        ide_debug.start()
    try:
        if is_directory(path):
            launch(path)
        else:
            cdcaux.app(path)
            os.chdir("/" if path.startswith("/.ide/") else path.rsplit("/", 1)[0] or "/")
            _run_file(path)
    except IDEStop:
        pass
    finally:
        if debug:
            ide_debug.stop()
        builtins.ide_mode = False


def _hold():
    draw = ide_display.hold()
    while cdcaux.held():
        badge.poll()
        if badge.pressed():
            cdcaux.release()
            break
        if draw:
            draw()
        time.sleep_ms(20)
    while badge.pressed() or badge.held():
        badge.poll()


def serve():
    if cdcaux.held():
        _hold()
    request = cdcaux.launch()
    if request is None:
        return
    path, debug, resume = request
    if resume:
        launch(path)
        reset()
    execute(path, debug)
    machine.soft_reset()


def safe_mode():
    draw = ide_display.safe_mode()
    while draw:
        draw()
        time.sleep_ms(20)

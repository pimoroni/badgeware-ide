import json
import sys
import time

import cdcaux

MAX_STACK = 32
MAX_REPR = 120
MAX_CHILDREN = 100
INIT_TIMEOUT_MS = 2000

_breakpoints = {}  # file -> {line: None, or a dict of condition, hitCount, logMessage, hits}
_break_on_exception = False
_run_to = None  # (file, line) of a one-off breakpoint
_exception = None  # the exception being unwound, and snapshots of the frames it left
_unwound = []
_mode = "run"
_step_frame = None
_rx = b""
_refs = []
_stopped_frames = []
_resume = False
_initialised = False
_current_frame = None


def _send(message):
    cdcaux.write(json.dumps(message) + "\n")


def _is_user_file(filename):
    return filename.startswith("/") and not filename.startswith("/.frozen")


def _frame_file(frame):
    return frame.f_code.co_filename


def _stack(frame):
    frames = []
    while frame is not None and len(frames) < MAX_STACK:
        frames.append(frame)
        frame = frame.f_back
    return frames


# A stopped frame is a live frame, or a dict snapshot of one an exception has
# already unwound, holding what its locals were as the exception passed.
def _snapshot(frame):
    module = frame.f_code.co_name == "<module>"
    return {
        "file": _frame_file(frame),
        "line": frame.f_lineno,
        "first": frame.f_code.co_firstlineno,
        "name": frame.f_code.co_name,
        "globals": frame.f_globals,
        "locals": None if module else dict(frame.f_locals),
    }


def _frame_info(frame):
    if isinstance(frame, dict):
        info = {key: frame[key] for key in ("file", "line", "first", "name")}
        info["unwound"] = True
    else:
        info = {"file": _frame_file(frame), "line": frame.f_lineno, "first": frame.f_code.co_firstlineno, "name": frame.f_code.co_name}
    info["user"] = _is_user_file(info["file"])
    return info


def _frame_scopes(frame):
    # (globals, locals) to evaluate in, locals None at module level.
    if isinstance(frame, dict):
        return frame["globals"], frame["locals"]
    if frame.f_code.co_name == "<module>":
        return frame.f_globals, None
    return frame.f_globals, frame.f_locals


def _evaluate(frame, expression):
    scope, local_scope = _frame_scopes(frame)
    return eval(expression, scope, scope if local_scope is None else local_scope)


def _short_repr(value, limit=MAX_REPR):
    try:
        text = repr(value)
    except Exception:  # noqa: BLE001
        text = "<" + type(value).__name__ + ">"
    if len(text) > limit:
        text = text[:limit - 3] + "..."
    return text


class _Function:
    # A function as cdcaux.describe() sees it, so expanding it lists its parts.
    def __init__(self, info):
        self.info = info


def _describe(value):
    describe = getattr(cdcaux, "describe", None)
    if describe is None or not callable(value) or isinstance(value, type):
        return None
    return describe(value)


def _name(entry):
    # describe() gives None for a name it doesn't have.
    return entry[0] or "?"


def _signature(info):
    def param(entry):
        return _name(entry) + "=" + _short_repr(entry[1], 24) if len(entry) > 1 else _name(entry)

    parts = [param(entry) for entry in info["params"]]
    if "varargs" in info:
        parts.append("*" + (info["varargs"] or "?"))
    elif info["kwonly"]:
        parts.append("*")
    parts += [param(entry) for entry in info["kwonly"]]
    if "varkw" in info:
        parts.append("**" + (info["varkw"] or "?"))
    name = info["name"]
    if "self" in info:
        name = type(info["self"]).__name__ + "." + name
    text = "def " + name + "(" + ", ".join(parts) + ")"
    if info["captured"]:
        text += "  captures " + ", ".join(_name(entry) for entry in info["captured"])
    if info["generator"]:
        text += "  (generator)"
    return text


def _has_children(value):
    if isinstance(value, (dict, list, tuple, set)):
        return len(value) > 0
    if isinstance(value, (str, bytes, bytearray, int, float, bool)) or value is None:
        return False
    if callable(value) and not isinstance(value, type):
        return False
    return hasattr(value, "__dict__")


def _variable(name, value):
    info = _describe(value)
    if info is not None:
        _refs.append(_Function(info))
        return {
            "name": name,
            "type": "method" if "self" in info else "function",
            "value": _signature(info),
            "ref": len(_refs),
            "source": {"file": info["file"], "line": info["line"], "user": _is_user_file(info["file"])},
        }
    ref = 0
    if _has_children(value):
        _refs.append(value)
        ref = len(_refs)
    return {"name": name, "type": type(value).__name__, "value": _short_repr(value), "ref": ref}


def _children(value):
    if isinstance(value, _Function):
        info = value.info
        items = [_variable("defined at", info["file"] + ":" + str(info["line"]))]
        items[0]["source"] = {"file": info["file"], "line": info["line"], "user": _is_user_file(info["file"])}
        if "self" in info:
            items.append(_variable("self", info["self"]))
        items += [_variable(_name(entry), entry[1]) for entry in info["captured"]]
        items += [_variable("default " + _name(entry), entry[1]) for entry in info["params"] + info["kwonly"] if len(entry) > 1]
        return items
    if isinstance(value, dict):
        items = [(_short_repr(key), item) for key, item in value.items()]
    elif isinstance(value, (list, tuple)):
        items = [(str(index), item) for index, item in enumerate(value)]
    elif isinstance(value, set):
        items = [(str(index), item) for index, item in enumerate(value)]
    else:
        items = sorted(value.__dict__.items())
    return [_variable(name, item) for name, item in items[:MAX_CHILDREN]]


def _locals(frame):
    try:
        local_scope = _frame_scopes(frame)[1]
    except AttributeError:
        return None
    if local_scope is None:
        return None
    return [_variable(name, value) for name, value in sorted(local_scope.items())]


def _globals(frame):
    variables = []
    for name, value in sorted(_frame_scopes(frame)[0].items()):
        if name.startswith("__"):
            continue
        if type(value).__name__ == "module":
            continue
        variables.append(_variable(name, value))
    return variables


def _send_screen(request_id):
    width, height, stride = screen.width, screen.height, screen.stride
    raw = memoryview(screen.raw)
    pixel_bytes = (len(raw) - (height - 1) * stride) // width
    row_bytes = width * pixel_bytes
    if stride != row_bytes:
        packed = bytearray(row_bytes * height)
        for y in range(height):
            packed[y * row_bytes:(y + 1) * row_bytes] = raw[y * stride:y * stride + row_bytes]
        raw = memoryview(packed)
    raw = raw[:row_bytes * height]
    pixel_format = "RGB565" if pixel_bytes == 2 else "RGBA8888"
    _send({"event": "screen", "id": request_id, "width": width, "height": height, "format": pixel_format, "bytes": len(raw)})
    cdcaux.write(raw)


def _handle(command):
    global _mode, _step_frame, _resume, _initialised, _run_to
    name = command.get("cmd")

    if name == "init":
        _initialised = True
        _breakpoints.clear()
        for filename, lines in command.get("breakpoints", {}).items():
            _breakpoints[filename] = _parse_breakpoints(lines)
        _set_exception_break(command.get("breakOnException", False))
        if command.get("stopOnEntry"):
            _mode = "step_in"

    elif name == "setBreakpoints":
        lines = command.get("lines", [])
        if lines:
            _breakpoints[command["file"]] = _parse_breakpoints(lines)
        else:
            _breakpoints.pop(command["file"], None)

    elif name == "setExceptionBreak":
        _set_exception_break(command.get("enabled", False))

    elif name == "runTo":
        if not _stopped_frames:
            return
        _run_to = (command["file"], command["line"])
        _mode = "run"
        _resume = True

    elif name == "pause":
        _mode = "pause"

    elif name in ("continue", "stepIn", "stepOver", "stepOut"):
        if not _stopped_frames:
            return
        _mode = {"continue": "run", "stepIn": "step_in", "stepOver": "step_over", "stepOut": "step_out"}[name]
        _step_frame = _stopped_frames[0]
        _resume = True

    elif name == "scopes":
        frame = _stopped_frames[command.get("frame", 0)]
        _send({"event": "scopes", "id": command.get("id"), "frame": command.get("frame", 0), "locals": _locals(frame), "globals": _globals(frame)})

    elif name == "expand":
        ref = command.get("ref", 0)
        children = _children(_refs[ref - 1]) if 0 < ref <= len(_refs) else []
        _send({"event": "children", "id": command.get("id"), "ref": ref, "children": children})

    elif name == "screen":
        _send_screen(command.get("id"))

    elif name == "eval":
        frame = _stopped_frames[command.get("frame", 0)] if _stopped_frames else _current_frame
        scope, local_scope = _frame_scopes(frame) if frame else ({}, None)
        local_scope = scope if local_scope is None else local_scope
        expression = command.get("expr", "")
        try:
            try:
                result = _variable("result", eval(expression, scope, local_scope))
            except SyntaxError:
                exec(expression, scope, local_scope)
                result = _variable("result", None)
            _send({"event": "evaluated", "id": command.get("id"), "result": result})
        except Exception as e:  # noqa: BLE001
            _send({"event": "evaluated", "id": command.get("id"), "error": type(e).__name__ + ": " + str(e)})


def _poll():
    global _rx
    if not cdcaux.any():
        return
    _rx += cdcaux.read()
    while b"\n" in _rx:
        line, _rx = _rx.split(b"\n", 1)
        if line.strip():
            command = {}
            try:
                command = json.loads(line)
                _handle(command)
            except Exception as e:  # noqa: BLE001
                _send({"event": "error", "id": command.get("id"), "message": type(e).__name__ + ": " + str(e)})


def _stop(frame, reason, unwound=(), exception=None):
    global _resume, _stopped_frames, _run_to
    _stopped_frames = list(unwound) + _stack(frame)
    _refs.clear()
    _resume = False
    _run_to = None
    event = {"event": "stopped", "reason": reason, "stack": [_frame_info(f) for f in _stopped_frames]}
    if exception is not None:
        event["exception"] = type(exception).__name__ + ": " + str(exception)
    _send(event)
    while not _resume:
        if not cdcaux.connected():
            _detach()
            break
        _poll()
        time.sleep_ms(5)
    _stopped_frames = []
    _refs.clear()
    _send({"event": "continued"})


def _detach():
    # The IDE went away while the app was paused: stop debugging and let the app
    # run on, so neither it nor the REPL is left waiting on a debugger.
    global _mode, _resume
    _breakpoints.clear()
    _mode = "run"
    _resume = True
    sys.settrace(None)
    cdcaux.claim(False)


def _parse_breakpoints(entries):
    # A plain line number, or {"line", "condition", "hitCount", "logMessage"}.
    lines = {}
    for entry in entries:
        if isinstance(entry, int):
            lines[entry] = None
        else:
            spec = {key: entry.get(key) for key in ("condition", "hitCount", "logMessage")}
            spec["hits"] = 0
            lines[entry["line"]] = spec
    return lines


def _hit_matches(hits, hit_count):
    # hitCount N or "==N" stops on the Nth hit, ">=N" on every hit from the Nth,
    # "%N" on every Nth hit.
    text = str(hit_count).strip()
    if text.startswith("%"):
        every = int(text[1:])
        return every > 0 and hits % every == 0
    if text.startswith(">="):
        return hits >= int(text[2:])
    return hits == int(text.lstrip("="))


def _log_text(frame, message):
    # A logpoint message with each {expression} replaced by its value.
    out = []
    while "{" in message and "}" in message[message.index("{"):]:
        start = message.index("{")
        end = message.index("}", start)
        out.append(message[:start])
        try:
            out.append(str(_evaluate(frame, message[start + 1:end])))
        except Exception as e:  # noqa: BLE001
            out.append("<" + type(e).__name__ + ": " + str(e) + ">")
        message = message[end + 1:]
    out.append(message)
    return "".join(out)


def _breakpoint_stops(frame, spec):
    if spec is None:
        return True
    if spec["condition"]:
        try:
            if not _evaluate(frame, spec["condition"]):
                return False
        except Exception as e:  # noqa: BLE001
            # Not a stop: MicroPython reports a loop body's line before the loop
            # variable is set, so a condition on it can fail once harmlessly.
            # Reported once, so a real mistake still shows.
            if not spec.get("reported"):
                spec["reported"] = True
                _send({"event": "output", "text": "Breakpoint condition " + spec["condition"] + ": " + type(e).__name__ + ": " + str(e)})
            return False
    spec["hits"] += 1
    if spec["hitCount"] and not _hit_matches(spec["hits"], spec["hitCount"]):
        return False
    if spec["logMessage"] is not None:
        _send({"event": "output", "text": _log_text(frame, spec["logMessage"])})
        return False
    return True


def _set_exception_break(enabled):
    global _break_on_exception, _exception
    _break_on_exception = bool(enabled)
    _exception = None
    _unwound.clear()


def _exception_unwinding(frame, info):
    # Stop where an exception leaves the outermost user frame unhandled. The
    # frames it already unwound are kept as snapshots, so their locals can still
    # be inspected. Without a debugger the badge shows its traceback as before.
    global _exception
    if not isinstance(info, tuple) or len(info) < 3 or info[2] is not False:
        return
    file = _frame_file(frame)
    if not _is_user_file(file):
        return
    if info[1] is not _exception:
        _exception = info[1]
        _unwound.clear()
    caller = frame.f_back
    if caller is not None and _is_user_file(_frame_file(caller)):
        if len(_unwound) < MAX_STACK:
            _unwound.append(_snapshot(frame))
        return
    unwound = list(_unwound)
    _exception = None
    _unwound.clear()
    _stop(frame, "exception", unwound, info[1])


def _should_stop(frame):
    file = _frame_file(frame)
    lines = _breakpoints.get(file)
    if lines and frame.f_lineno in lines and _breakpoint_stops(frame, lines[frame.f_lineno]):
        return "breakpoint"
    if _run_to is not None and _run_to == (file, frame.f_lineno):
        return "breakpoint"
    if _mode == "pause":
        return "pause"
    if _mode == "step_in":
        return "step"
    if _mode == "step_over" and frame is _step_frame:
        return "step"
    return None


def _trace_local(frame, event, _arg):
    global _mode, _current_frame
    if event == "line":
        _current_frame = frame
        _poll()
        _current_frame = None
        reason = _should_stop(frame)
        if reason:
            _stop(frame, reason)
    elif event == "return":
        if frame is _step_frame and _mode in ("step_over", "step_out"):
            _mode = "step_in"
    elif event == "exception" and _break_on_exception:
        _exception_unwinding(frame, _arg)
    return _trace_local


def _trace(frame, event, _arg):
    if event != "call":
        return None
    if not _is_user_file(_frame_file(frame)) and _mode != "step_in":
        return None
    return _trace_local


def start():
    global _mode, _step_frame, _rx, _initialised
    _mode = "run"
    _step_frame = None
    _rx = b""
    _initialised = False
    _breakpoints.clear()
    cdcaux.claim(True)
    while cdcaux.any():
        cdcaux.read()
    _send({"event": "ready"})
    deadline = time.ticks_add(time.ticks_ms(), INIT_TIMEOUT_MS)
    while not _initialised and time.ticks_diff(deadline, time.ticks_ms()) > 0:
        _poll()
        time.sleep_ms(5)
    sys.settrace(_trace)


def stop():
    global _current_frame
    sys.settrace(None)
    _current_frame = None
    _send({"event": "terminated"})
    cdcaux.claim(False)

"""Runs each conformance case in CPython and prints the outcomes as JSON.

Reads a JSON list of {"name", "code"} on stdin. Each case runs in a fresh
namespace with stdout captured; the outcome is its printed output plus the
type and message of the exception that ended it, if any.
"""
import contextlib
import io
import json
import re
import sys


def run(code):
    out = io.StringIO()
    error = None
    try:
        with contextlib.redirect_stdout(out):
            exec(compile(code, "<case>", "exec"), {"__name__": "__main__"})
    except BaseException as e:  # noqa: BLE001 - the outcome includes any failure
        message = str(e)
        # An ImportError names the module's file on this machine; drop the path.
        if isinstance(e, ImportError):
            message = re.sub(r" \(/[^)]*\)$", "", message)
        error = {"type": type(e).__name__, "message": message}
    return {"stdout": out.getvalue(), "error": error}


cases = json.load(sys.stdin)
json.dump(
    {
        "python": sys.version.split()[0],
        "cases": {case["name"]: run(case["code"]) for case in cases},
    },
    sys.stdout,
    indent=1,
    sort_keys=True,
)

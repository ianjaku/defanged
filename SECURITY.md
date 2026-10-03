# Security

defanged exists to run untrusted Python safely, so a way to escape the sandbox is the most serious bug it can have. If you find one, please report it privately first so a fix can ship before the details are public.

## Reporting

Use GitHub's private vulnerability reporting: **Security → Report a vulnerability** on this repository. If that is not available to you, email ian@invacto.com with "defanged" in the subject.

Include a script that demonstrates the problem and the version of defanged, Node or Bun, and the OS you ran it on. A minimal reproduction is worth more than a long write-up.

You will get an acknowledgement within a few days. Reports that turn out to be in scope get a fix, a release and credit in the release notes unless you prefer otherwise.

## What counts

In scope:

- Any way for a script to read or write files, open a network connection, start a process, or otherwise reach outside the interpreter without going through a tool the host registered.
- Any way for a script to run JavaScript, or to reach the host's objects (prototype pollution through tool arguments or results, for example).
- Any way for a script to keep running after `timeoutMs` or `maxIterations` is exceeded, or to allocate past the `limits` the host set, other than the gaps listed under "Residual risks" in the README (a single synchronous operation such as a backtracking regex cannot be interrupted).
- A crash of the host process from script input (an uncaught exception that is not one of the documented error classes, a stack overflow that is not turned into `RecursionError`).

Out of scope:

- What a tool handler does with its arguments. A tool that runs SQL from a string is the host's responsibility.
- Resource exhaustion inside a tool handler.
- Behaviour that differs from CPython without a safety consequence; that is a bug, and a public issue is the right place for it.

## Supported versions

Fixes go into the latest release. There are no long-lived release branches.

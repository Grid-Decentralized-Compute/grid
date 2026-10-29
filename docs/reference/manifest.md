# Swarm manifest

The JSON description of a swarm job.

```json
{
  "v": 1,
  "image": "python:3.12-slim",
  "command": "python -c \"import sys; print(sum(int(n) for n in sys.stdin.read().split()))\"",
  "gpu": false,
  "tasks": ["1 2 3", "4 5 6", "7 8 9"]
}
```

## Fields

| Field | Description |
| --- | --- |
| `v` | Always `1` |
| `image` | Container image. Pin a digest (`image@sha256:…`) so every host runs the same bytes |
| `command` | Run with `sh -c` inside the container. Reads the task input on stdin, writes the result to stdout |
| `gpu` | `true` to require a GPU; hosts without one skip the job |
| `tasks` | One string per task, passed on stdin as is. A task's number is its index |

## Encoding

The manifest is the `manifest` argument of `postJob`, UTF-8 encoded, at most 64 KB. The contract stores its keccak256 hash and emits it in `JobPosted`; hosts read it from that event and check the hash. It is therefore public.

## Results

A run's result is the keccak256 hash of its exact stdout, up to 1 MB.

* A non-zero exit gives `error: exit <code>` followed by the output.
* A timeout gives `error: timed out`.

Honest hosts report failures the same way, so replicas still agree on them.

# Running a swarm job

A swarm job is one job split into independent tasks and spread across many hosts at once. Every result is checked by a second machine.

## When to use it

Use a swarm job when the work splits into pieces that each take an input and produce an output: rendering frames, running a model over a dataset, transcoding files, simulations, batch data processing. Each piece is a task, and tasks run in parallel on whichever hosts are idle.

## Steps

1. Choose **Swarm** on the market and fill in the container image, the command, and the inputs, one task per line. The command runs with `sh -c`; the task's input arrives on stdin and its stdout is the result.
2. Set a price per run and how long a host may take per task. The job escrows three runs of every task: two replicas and one spare for a tie-break.
3. Post the job. The job page shows every task as it moves from waiting to running to done, and how many hosts are working on it.
4. Open any finished task to see its output, fetched from a host that produced it and checked against the hash stored on-chain. **Download results** collects them all as JSON.
5. When the job is done, choose **Close and refund**. Runs that were not needed return to your balance.

## How results are trusted

Every task runs on two different hosts, which each submit the keccak256 hash of their output.

* Matching hashes pay both hosts.
* Different hashes open the spare run on a third host. The two that agree are paid and the other host is recorded as a fault against its bond.
* If all three disagree, the task fails and none of them is paid.
* A host that takes a task and disappears loses it when its lease runs out; another host takes it over.

## Rules for a good job

* **Deterministic.** The same input must give byte-identical output on any machine. Pin the image by digest, fix random seeds, keep timestamps out of the output.
* **Self-contained.** Task containers have no network unless the host allows it. Put what a task needs in the image or the input.
* **Public.** The job description, including every input, is published on-chain. Outputs can be fetched by anyone who knows the job.
* **Small outputs.** A task's output is kept up to 1 MB.

The full format is in [Swarm manifest](../reference/manifest.md).

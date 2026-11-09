# Retrieval evaluation

The original 24 tasks and Express/Flask/Gin set are exposed regression material.
The Undici/Requests/Cobra set was created after freezing the ranking algorithm
at SHA-256 `a1c59a2798b49baa5a4e9909f3332fb2a34cd4fd6301ff03ba35ef6f7c90c728`.
Its first required-range results were retained before reviewing auxiliary labels.
The algorithm was not tuned against those results. Future runs are regression
checks, not new blind evaluations. Each repository includes 32 source files,
its exact upstream commit and complete license. Sample code is never executed.

Required labels cover the complete primary local definition. Auxiliary labels
identify additional definitions whose identifiers occur in the primary code;
they do not claim compiler-confirmed or runtime calls. The review file records
source hashes and the local-analysis limits. Primary-range and auxiliary-range
coverage are reported separately. These tasks do not measure whole-repository
understanding or real model answer quality.

## Metrics and gate

Recall and coverage include every task. Waste ratios use the union of required
and annotated auxiliary lines (overlap counted once). A task without sendable
context has a **null** waste ratio; it is never reported as zero waste.
`outsideRequiredRatio` separately retains the stricter primary-only measure.

`contextLoss` evaluates every task: unsendable or empty output receives maximum
loss **1**; sendable output receives its measured waste fraction. This prevents
failure-heavy baselines from being incomparable or being rewarded for sending
nothing. It is not a confidence score for model conclusions.

The gate runs both sets, separately for each language and overall. Recall@5,
necessary-file coverage and required-range coverage must not regress; valid
sample counts must strictly improve and all-task context loss must strictly
decrease. When both waste ratios are available, waste must strictly decrease
too. The overall group additionally requires improved recall or necessary-file
coverage. A missing ratio remains explicitly unavailable; it is not converted
to a successful comparison. Two runs with no valid output cannot pass.

Changes to labels and metric definitions must retain old results and explain
their effect. CI stores the raw result and fails on gate failure.

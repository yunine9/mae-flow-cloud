# Review

Review is advisory evidence. Read the relevant Spec or Story, current code, and exact change before judging it.

- Verify the review claim against code and requirements before changing code. Clarify or reject an unsupported finding with technical evidence.
- Trace a confirmed defect to its root cause. Prefer the smallest correction that restores the approved behavior without unrelated cleanup.
- Review correctness, boundary behavior, dependency direction, reuse, naming, ownership, error handling, lifetime, concurrency, compatibility, and the planned test seam.
- Separate objective defects from valid design tradeoffs. Only a real unresolved tradeoff needs user judgment.

For final conformance, compare the final implementation and final diff with the confirmed Spec and confirmed Story:

- Completeness: required observable behaviors have implementation and coverage evidence.
- Correctness: behavior and accepted scenarios match the confirmed WHAT.
- Coherence: code structure and dependencies follow the reviewed design decisions, or an explicit deviation is surfaced.

The Design Reviewer runs exactly once per Full Story. When selected, the CODE Reviewer runs once before human review and inspects the complete uncommitted change plus direct integration boundaries. Accepted fixes do not schedule another reviewer pass.

Run an integration review only for cross-module coupling, shared state, interface change, or late design change. This choice is based on semantic risk, not file or line count.

# Construction

## Objective

The main Agent implements the whole approved production-code change directly from the local Spec and Story.

## Inspect

Read the confirmed behavior, design boundaries, affected code, repository build configuration, and intended test seam. Do not delegate implementation, split it into batches, or create extra planning artifacts.

## Stop for the user

Keep the complete change uncommitted for the optional one-time read-only Agent precheck and mandatory user review. A requested revision returns to main-Agent editing and compile-agent verification, then to user review.

## Outputs

- Complete uncommitted production-code change.
- A compile-agent result from the task card's configured Skill or exact repository build method.
- A whole-change UT handoff; formal UT remains in Quality.

## Next

After user approval, commit the exact reviewed change and enter the existing Quality chain.

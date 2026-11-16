Submits the crew plan: validates it, casts each item onto a roster model, and shows the Casting Board to Gaurav. Nothing spawns until he approves.

- Call `crew_models` first and choose each item's `model` yourself (exact selector) with a one-line `reason`. Items without `model` are auto-cast: the cheapest model at or above the item's floor tier (difficulty; frontend/design/architecture work is never below tier 2) with the best strength fit, inside the crew policy.
- The crew policy (`crew_policy`) is enforced: a `model` that breaks it is skipped and auto-cast instead; an item nothing can satisfy comes back as an error listing what the policy allows.
- Validation errors (duplicate ids, unknown deps, cycles, empty briefs, overlapping write scopes between items that can run at the same time) come back as an error listing each problem; fix the plan and call again.
- Rejected on the board: the error carries Gaurav's note and his row edits. Change something real before resubmitting (models, items, or policy); an identical resubmission is refused. His model picks from the board carry over to the next plan for the same item ids.
- Approved: returns the run id and the cast (worker, model, est cost) immediately. Workers start as their dependencies finish; results deliver themselves.

One plan runs at a time. To grow a running crew use `crew_add`; to change a model use `crew_reassign`.

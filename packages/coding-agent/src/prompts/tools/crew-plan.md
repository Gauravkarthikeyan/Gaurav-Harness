Submits the crew plan: validates it, casts each item onto a roster model, and shows the Casting Board to Gaurav. Nothing spawns until he approves.

- Validation errors (duplicate ids, unknown deps, cycles, empty briefs, overlapping write scopes between items that can run at the same time) come back as an error listing each problem; fix the plan and call again.
- Rejected on the board: the error carries Gaurav's note; revise and resubmit.
- Approved: returns the run id and the cast (worker, model, est cost) immediately. Workers start as their dependencies finish; results deliver themselves.

One plan runs at a time. A new plan while one is running is refused; finish or kill the current run first.

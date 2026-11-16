Adds work items to the running crew (same item shape as `crew_plan`). Only the new items are validated against the run (ids, dependencies on existing items, write scopes of items still running or waiting), cast, and shown on the Casting Board; once approved they start as soon as their dependencies are done. Existing workers keep running.

Use it for a second worker on a live run, a review item for a finished one, or a fix-up item. Without an active run it behaves like `crew_plan`.

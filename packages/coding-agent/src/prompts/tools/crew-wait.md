Blocks until one watched item changes state (finishes, fails), the timeout passes, or you are interrupted. Returns every item's state. Worker reports deliver themselves as messages; call this only when you cannot do anything else until a result lands.

- `items`: ids to watch; omit to watch every running item.
- `timeout`: seconds (default 30).

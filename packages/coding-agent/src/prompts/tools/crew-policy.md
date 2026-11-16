Sets the session's crew policy: the casting rules every plan, addition, reassignment and escalation must follow until changed. Call it the moment Gaurav states a preference, before planning:

- "use open-weight / open-source models" → `openWeightOnly: true`
- "only use commandcode", "no anthropic" → `providers` / `excludeProviders`
- "keep it cheap" → `maxTier`; "I want good quality" → `preferQuality: true` (one tier above each item's floor)

Fields you pass replace the old ones; `clear: true` resets everything. Returns the policy and the models it allows, or an error when nothing connected satisfies it.

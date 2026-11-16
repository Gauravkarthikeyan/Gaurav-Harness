Lists every connected model the crew can use, one row each: selector, provider, tier (1 mechanical · 2 normal engineering · 3 frontier), price per 1M tokens in/out, estimated cost for an S/M/L item, strengths, whether the weights are open, context window, and measured speed. The current crew policy is shown on top and models it rules out are marked.

Call it before planning (and again when Gaurav names models, providers or open weights) so you can pick `model` per item yourself: hard or user-visible work on a strong model, mechanical work on a cheap one, reviews one tier above the work they review.

`filter` narrows the list: `openWeight`, `provider`, `minTier`, `skills` (models whose strengths cover any of them).

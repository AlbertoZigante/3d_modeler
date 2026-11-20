# fixtures/golden — frozen reference answers of the ORIGINAL JS engine

One folder per design: `raw.json` (the input), and what the client-side JavaScript engine answered for it
before the business logic moved to the Python API (migration phase 12): `resolved`, `joints`, `featureJoints`,
`hardware`, `sequence`, `assembly`, `legacyBom`, `legacyNesting` (`.json` each).

They are DATA now: the JS that produced them was deleted. Who uses them:

- `tests/stepsI18n.test.mjs` — checks that the manual built from the API's structured steps has the same content as the one
  built from the old JS planner's output (`sequence.json`).
- the API repo keeps an identical copy (`api/tests/golden`) as its regression contract; a bigger frozen corpus (703 designs)
  lives there too (`tests/golden/corpus.jsonl.gz`).

The generator and the JS engine are in git history: tag `pre-phase12` (`git checkout pre-phase12`).
Do not edit these files by hand.

# Vietnamese Pronunciation Listening Evaluation

**Status:** Pending human review
**Required result:** improved path preferred in at least 16 of 20 samples; zero semantic regressions in must-not-change samples

Use the same voice and speed for baseline and improved audio. Randomize A/B
order, hide path labels from the reviewer, and sign the completed report before
creating a release tag. Automated tests must not fill reviewer judgments.

| ID    | Target                            | Reviewer | Preferred | Semantic error | Pause issue | Repeated/skipped | TTFA concern |
| ----- | --------------------------------- | -------- | --------- | -------------- | ----------- | ---------------- | ------------ |
| VI-01 | `ĐH` unique expansion             | pending  | pending   | pending        | pending     | pending          | pending      |
| VI-02 | ambiguous `ĐH` context            | pending  | pending   | pending        | pending     | pending          | pending      |
| VI-03 | unknown uppercase abbreviation    | pending  | pending   | pending        | pending     | pending          | pending      |
| VI-04 | full date                         | pending  | pending   | pending        | pending     | pending          | pending      |
| VI-05 | leap date                         | pending  | pending   | pending        | pending     | pending          | pending      |
| VI-06 | decimal                           | pending  | pending   | pending        | pending     | pending          | pending      |
| VI-07 | grouped number                    | pending  | pending   | pending        | pending     | pending          | pending      |
| VI-08 | money                             | pending  | pending   | pending        | pending     | pending          | pending      |
| VI-09 | measurement                       | pending  | pending   | pending        | pending     | pending          | pending      |
| VI-10 | percentage                        | pending  | pending   | pending        | pending     | pending          | pending      |
| VI-11 | numeric range                     | pending  | pending   | pending        | pending     | pending          | pending      |
| VI-12 | version                           | pending  | pending   | pending        | pending     | pending          | pending      |
| VI-13 | comma pause                       | pending  | pending   | pending        | pending     | pending          | pending      |
| VI-14 | semicolon pause                   | pending  | pending   | pending        | pending     | pending          | pending      |
| VI-15 | spaced-dash pause                 | pending  | pending   | pending        | pending     | pending          | pending      |
| VI-16 | sentence pause                    | pending  | pending   | pending        | pending     | pending          | pending      |
| VI-17 | paragraph pause                   | pending  | pending   | pending        | pending     | pending          | pending      |
| VI-18 | URL/email preservation            | pending  | pending   | pending        | pending     | pending          | pending      |
| VI-19 | identifier and phone preservation | pending  | pending   | pending        | pending     | pending          | pending      |
| VI-20 | invalid-date preservation         | pending  | pending   | pending        | pending     | pending          | pending      |

## Weighted segmentation and replay follow-up

All four follow-up cases must have no semantic error, repeated/skipped unit, or
unacceptable TTFA regression. A repeated sound inside one buffer must be marked
as an acoustic issue; a whole unit played twice is a queue failure.

| ID    | Target                                      | Reviewer | Semantic error | Pause issue | Repeated/skipped | Acoustic repeat | TTFA concern |
| ----- | ------------------------------------------- | -------- | -------------- | ----------- | ---------------- | --------------- | ------------ |
| VI-21 | consecutive short sentences in one unit     | pending  | pending        | pending     | pending          | pending         | pending      |
| VI-22 | long sentence with mixed punctuation        | pending  | pending        | pending     | pending          | pending         | pending      |
| VI-23 | punctuation-sparse paragraph over 300 chars | pending  | pending        | pending     | pending          | pending         | pending      |
| VI-24 | speed change while next unit is synthesizing | pending  | pending        | pending     | pending          | pending         | pending      |

Reviewer signature: pending

Review date: pending

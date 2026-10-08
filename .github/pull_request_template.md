<!-- devolps pull request template (GH-04). The merge gate reads the "Docs impact" and
     "Regression test" lines; the change-size check reads "Large-CL-Justification". -->
Task: <task id>   Story: <story id>   Track: <full | quick | bugfix>

## Criteria
- [ ] <criterion ID> <plain-English line> — test: <test name>

## Evidence
<check> -> <pass | fail>

## Size
<n> changed lines
<!-- Over 1000 lines? Add: Large-CL-Justification: <why> -->

Docs impact: <what changed, or none: why>
Security impact: <threat-model elements touched, or none>
Regression test: <bug fixes only: test name>
Rollback: <how to undo this change>

## Definition of Done
- [ ] Every criterion passes its check
- [ ] Tests pass
- [ ] Review findings resolved
- [ ] Docs updated, or no docs impact
- [ ] Merged by the PM through /devolps:ship

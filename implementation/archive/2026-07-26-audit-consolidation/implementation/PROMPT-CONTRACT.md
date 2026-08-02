# Prompt contract for lower-capability models

This program applies Anthropic's
[Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
as an engineering control.

The guide recommends clear/direct instructions, relevant context, structured
tags, explicit action/tool direction, verification against success criteria,
incremental state tracking, and draft-review-refine chains. It also warns
against speculative file creation, overengineering, hard-coding to tests, and
claims about code that was not inspected. Every packet uses that contract.

## Required session shape

1. **Investigate:** read the packet, cited audit entries, and every named source
   and test file. Quote short evidence with paths/lines in work notes.
2. **Plan:** restate the smallest implementation and its invariants. Do not add
   adjacent refactors.
3. **Test first where practical:** prove the actual defect, not a mocked
   restatement of an implementation detail.
4. **Implement:** use existing patterns and preserve public contracts.
5. **Verify:** run focused tests, relevant lint/typecheck, and earlier gates.
6. **Review:** inspect the final diff for scope, cleanup ownership, hard-coded
   values, stale comments, and missing directly affected docs.
7. **Handoff:** report changed files, exact command results, acceptance criteria,
   limitations, and decisions. Never claim an unrun check passed.

## Standard dispatch wrapper

```xml
<role>
You are implementing one bounded remediation in Nextra. Work as a careful
maintainer of a single-node real-time media application.
</role>

<context>
Read implementation/PROMPT-CONTRACT.md, the assigned packet, and every file it
names. The packet and repository are authoritative. Do not speculate about code
you have not opened.
</context>

<objective>
[Copy the packet objective here.]
</objective>

<constraints>
- Make only changes required by this packet.
- Preserve its invariants and the documented single-node product contract.
- Do not edit/delete tests merely to make the suite pass.
- Implement general behavior, not fixture-specific values.
- Reuse repository patterns; add no dependency without approval.
- Create no unrelated helper, documentation, or abstraction.
- Remove temporary files before handoff.
</constraints>

<process>
1. Investigate and cite current evidence.
2. State a minimal plan and expected failing/passing tests.
3. Implement the smallest complete change.
4. Run every required verification command.
5. Self-review against the acceptance criteria.
</process>

<output>
Return: summary; changed files; commands with exact results; acceptance checklist;
remaining limitations/decisions. If blocked, stop with evidence and the smallest
question needed to continue.
</output>
```

## Model and context guidance

- Use higher effort only for relay generation, async admission, or restart state.
- Put long logs/context before the final objective and output contract.
- If a model misses a contract, add 3-5 small diverse transition examples rather
  than broad emphatic prose.
- Use a separate review call for packets 03/04/05/async scrypt: give the review
  model the objective, invariants, diff, and test output; ask only for actionable
  violations, then send those back to the implementer.
- Ask for concise evidence/decisions/results, not hidden chain-of-thought.

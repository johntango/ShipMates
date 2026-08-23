---
name: firstmate-readonly
description: Read the durable status, design, plan, artifacts, and technical evidence for a local First Mate workflow. Use when the user asks what First Mate is doing, what it planned, what it created, or what validation recorded.
---

# First Mate read-only workflow view

Use the First Mate read-only tools to answer questions about the current local
ShipMates workflow.

- Use `firstmate_status` for current state and the next safe action.
- Use `firstmate_current_design` or `firstmate_current_plan` for scope.
- Use `firstmate_artifacts` for created files and a durable candidate page link.
- Use `firstmate_technical_evidence` only when the user asks for commands,
  detailed checks, or diagnostics.

These tools are read-only. They cannot approve a plan, launch or cancel work,
modify a workspace, clean evidence, commit code, or publish anything. Explain
that boundary plainly instead of implying that an action has occurred.

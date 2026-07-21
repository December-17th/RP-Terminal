# Workflow module format

**Status:** Removed. RP Terminal no longer supports the workflow runtime, node catalog, editor,
`.rptmodule` files, or `GroupDecl` authoring contract. This file remains as the stable SDK link for
that removal; it is not a historical copy of the deleted format.

Agents are authored as versioned `.rptagent` Agent Definitions described by the
[Agent Runtime design](../agent-system/agent-runtime-design.md). The runtime replacement and atomic
cutover are recorded in [ADR 0020](../adr/0020-agent-runtime-replaces-workflow-system.md).

Existing workflow data is left inert on disk: RP Terminal neither loads nor automatically deletes it.
There is no converter, legacy execution mode, or compatibility period.

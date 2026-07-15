// Wires workflowService's card-import ops into characterService's CardWorkflowHooks seam.
//
// Why a separate module: workflowService transitively imports chatService → characterService, so
// characterService cannot import workflowService directly (dependency-cruiser keeps the main graph
// acyclic). This bridge — imported ONLY by the composition root (index.ts) and the import test, never
// by a service — sits above both and injects the ops. It mirrors how agentPackService registers into
// workflowService's setEnabledFragmentsProvider seam, without dragging workflowService's large
// dependent set into characterService (or characterService's subtree into every workflow test).
//
// The registration is a module side-effect: importing this file (for its side-effect) wires the hooks.
import { setCardWorkflowHooks } from './characterService'
import {
  importWorkflowFromObject,
  setWorldWorkflow,
  deleteWorkflowsByOwner
} from './workflowService'

setCardWorkflowHooks({
  importWorkflow: (profileId, doc, owner) => {
    const res = importWorkflowFromObject(profileId, doc, { owner })
    return res.ok ? res.id : null
  },
  setWorldWorkflow,
  deleteWorkflowsByOwner
})

---------------------- MODULE WriteBatchRefinementProofs ----------------------
EXTENDS WriteBatchProtocol, WritePublicationCoreProofs, TLAPS

\* Semantic refinement only. This does NOT establish CutMatchesPublication,
\* PreparedEpochsCurrent, projection/count properties, or concrete liveness.
\* Those obligations are checked by TLC here, not proved deductively yet.

THEOREM BatchStepRefines ==
  CoreType /\ GuardReply /\ [Next]_allvars => [CoreNext]_CoreVars
BY SMT DEF Next, allvars, CoreNext, CoreVars, CoreType, OwnerTxns,
  GroupStep, Admit, Reject, Refresh, Prepare, Acquire, ConfirmGate, DecideGroup,
  DeliverApply, ConfirmApply, FinishOwner, ConfirmOwner, DispatchPublish,
  PublishGroup, ConfirmPublication, Release, FinishRelease, Reply, LoseReply,
  AdvanceEpoch, Crash, Recover, Capture, Scan, FinishRead,
  Decide, Apply, Publish, Acknowledge

THEOREM BatchPreservesCoreInvariant ==
  CoreInv /\ GuardReply /\ [Next]_allvars => CoreInv'
BY BatchStepRefines, NextPreserves, SMT DEF CoreInv

BatchCoreInv == CoreInv /\ GuardReply

THEOREM BatchInitialInvariant == GuardReply /\ Init => BatchCoreInv
BY InitialInvariant, SMT DEF Init, BatchCoreInv

THEOREM BatchInvariantStep == BatchCoreInv /\ [Next]_allvars => BatchCoreInv'
BY BatchPreservesCoreInvariant, SMT DEF BatchCoreInv

THEOREM BatchInvariantAlways == GuardReply /\ Spec => []BatchCoreInv
BY BatchInitialInvariant, BatchInvariantStep, PTL DEF Spec

THEOREM SemanticStep == BatchCoreInv /\ [Next]_allvars => [CoreNext]_CoreVars
BY BatchStepRefines, SMT DEF BatchCoreInv, CoreInv

THEOREM InitialRefinement == Init => CoreInit
BY SMT DEF Init

THEOREM BatchRefinesCore == GuardReply /\ Spec => CoreSpec
BY SemanticStep, BatchInvariantAlways, InitialRefinement, PTL DEF Spec, CoreSpec

THEOREM BatchSemanticSafety == GuardReply /\ Spec => []CoreSafety
BY BatchRefinesCore, PublicationSafety, PTL
=============================================================================

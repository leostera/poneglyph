---------------------- MODULE WritePublicationCoreProofs ----------------------
EXTENDS WritePublicationCore, TLAPS

THEOREM InitialInvariant == CoreInit => CoreInv
BY SMT DEF CoreInit, CoreInv, CoreType, OwnerTxns

THEOREM DecidePreserves ==
  ASSUME CoreInv, NEW C, NEW R, Decide(C, R)
  PROVE CoreInv'
BY SMT DEF Decide, CoreInv, CoreType, OwnerTxns

THEOREM ApplyPreserves ==
  ASSUME CoreInv, NEW o, NEW B, Apply(o, B)
  PROVE CoreInv'
BY SMT DEF Apply, CoreInv, CoreType, OwnerTxns

THEOREM PublishPreserves ==
  ASSUME CoreInv, NEW B, Publish(B)
  PROVE CoreInv'
BY SMT DEF Publish, CoreInv, CoreType, OwnerTxns

THEOREM AckPreserves ==
  ASSUME CoreInv, NEW B, Acknowledge(B)
  PROVE CoreInv'
BY SMT DEF Acknowledge, CoreInv, CoreType, OwnerTxns

THEOREM NextPreserves == CoreInv /\ [CoreNext]_CoreVars => CoreInv'
BY DecidePreserves, ApplyPreserves, PublishPreserves, AckPreserves,
   SMT DEF CoreNext, CoreVars, CoreInv, CoreType, OwnerTxns

THEOREM InvariantImpliesSafety == CoreInv => CoreSafety
BY ParticipantTyping, SMT DEF CoreInv, CoreType, CoreSafety, OwnerTxns

THEOREM InvariantAlways == CoreSpec => []CoreInv
BY InitialInvariant, NextPreserves, PTL DEF CoreSpec

THEOREM PublicationSafety == CoreSpec => []CoreSafety
BY InvariantAlways, InvariantImpliesSafety, PTL

THEOREM DecisionStepMonotonic ==
  CoreInv /\ [CoreNext]_CoreVars =>
    /\ s.committed \subseteq s'.committed
    /\ s.aborted \subseteq s'.aborted
BY SMT DEF CoreInv, CoreType, CoreNext, CoreVars, Decide, Apply, Publish, Acknowledge

THEOREM DecisionsNeverForgotten == CoreSpec =>
  [] [s.committed \subseteq s'.committed /\ s.aborted \subseteq s'.aborted]_CoreVars
BY InvariantAlways, DecisionStepMonotonic, PTL DEF CoreSpec
=============================================================================

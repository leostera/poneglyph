-------------------------- MODULE ReadHeadRoutingProofs --------------------------
EXTENDS ReadHeadRouting, TLAPS

\* Types and the global head-publication invariant are EXPLICIT premises. These
\* proofs establish only routing/completed-projection composition, not those
\* premises, cache population correctness, authorization, or implementation timing.
THEOREM HeadCompletionSound ==
  RoutingType /\ ConditionalReadsCurrent /\ GuardReadHeadAuthority /\ CompleteFromHead => RoutingSafety'
BY SMT DEF RoutingType, TypeOK, ConditionalReadsCurrent, CompleteFromHead,
  ProbeMatches, RoutingSafety, SameProjection

THEOREM CanonicalCompletionSound ==
  RoutingType /\ GuardCanonicalFallback /\ CompleteFromCanonical => RoutingSafety'
BY SMT DEF RoutingType, TypeOK, CompleteFromCanonical, RoutingSafety, SameProjection

THEOREM RoutingInitialSafety == RoutingInit => RoutingSafety
BY SMT DEF RoutingInit, RoutingSafety

THEOREM NoncompletionPreservesSafety ==
  RoutingType /\ RoutingSafety /\ [RoutingNext]_routingVars =>
    RoutingSafety' \/ CompleteFromHead \/ CompleteFromCanonical
BY SMT DEF RoutingType, TypeOK, RoutingNext, routingVars, BeginQuery, MissHead, FailClosed, RoutingSafety

THEOREM RoutingSafetyStep ==
  RoutingType /\ ConditionalReadsCurrent /\ GuardReadHeadAuthority /\ GuardCanonicalFallback /\
  RoutingSafety /\ [RoutingNext]_routingVars => RoutingSafety'
BY HeadCompletionSound, CanonicalCompletionSound, NoncompletionPreservesSafety, SMT

RoutingInv == RoutingSafety /\ GuardReadHeadAuthority /\ GuardCanonicalFallback

THEOREM RoutingInitialInvariant ==
  GuardReadHeadAuthority /\ GuardCanonicalFallback /\ RoutingInit => RoutingInv
BY RoutingInitialSafety, SMT DEF RoutingInv

THEOREM RoutingInvariantStep ==
  RoutingType /\ ConditionalReadsCurrent /\ RoutingInv /\ [RoutingNext]_routingVars => RoutingInv'
BY RoutingSafetyStep, SMT DEF RoutingInv

THEOREM RoutingCompositionInvariant ==
  GuardReadHeadAuthority /\ GuardCanonicalFallback /\ RoutingSpec /\
  []RoutingType /\ []ConditionalReadsCurrent => []RoutingInv
BY RoutingInitialInvariant, RoutingInvariantStep, PTL DEF RoutingSpec

THEOREM RoutingCompositionSafety ==
  GuardReadHeadAuthority /\ GuardCanonicalFallback /\ RoutingSpec /\
  []RoutingType /\ []ConditionalReadsCurrent => []RoutingSafety
BY RoutingCompositionInvariant, PTL DEF RoutingInv
=============================================================================

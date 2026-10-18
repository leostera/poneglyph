------------------------- MODULE ReadHeadKernelProofs -------------------------
EXTENDS ReadHeadPublication, TLAPS

\* These are local transition lemmas over the ACTUAL read-head model operators.
\* They are not a proof of Spec => []ServingHeadsCurrent or of liveness.
\* Head/version/generation values below are unbounded naturals, not TLC ranges.
\* In particular, FrozenValidationSound assumes the global two-publication
\* relationship explicitly; establishing it inductively remains separate work.

ProofHeads == [mode : Modes, generation : Nat, committed : Nat,
               prepared : Nat, established : BOOLEAN, up : BOOLEAN]
ProofCommands == [generation : Nat, version : Nat]

THEOREM ActivationRejectsStaleGeneration ==
  \A h \in ProofHeads, c \in ProofCommands :
    GuardActivationFence /\ h.generation # c.generation
      => Activated(h, c) = h
BY SMT DEF Activated

THEOREM RetirementIsIrreversible ==
  \A h \in ProofHeads, c \in ProofCommands :
    h.mode = "retired" =>
      /\ Prepared(h, c) = h
      /\ Bootstrapped(h, c) = h
      /\ Frozen(h, c) = h
      /\ Activated(h, c) = h
      /\ Retired(h, c).mode = "retired"
BY SMT DEF ProofHeads, ProofCommands, Prepared, Bootstrapped, Frozen, Activated, Retired

THEOREM FrozenValidationSound ==
  \A h \in ProofHeads, current \in Nat, scope \in SUBSET Owners :
    /\ h.mode = "frozen"
    /\ MayValidate(h, scope)
    /\ current \in {h.committed, h.prepared}
    => SameProjection(h.committed, current, scope)
BY SMT DEF MayValidate, SameProjection

=============================================================================

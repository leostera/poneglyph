------------------------- MODULE WriteBatchProtocol -------------------------
EXTENDS WritePublicationCore, FiniteSets, Sequences, TLC
CONSTANTS Groups, Members, Valid, AdmissionHome, TxnOrder, OwnerOrder, MaxActive, MaxEpoch,
          MaxCrashes, GuardEpoch, GuardClosed, GuardReply, GuardIndependent,
          GuardExactlyOnce, GuardPublishReplay, Incremental

\* Candidate protocol, NOT deployed. Fixed disjoint batches abstract dynamic
\* scheduling. Valid represents independently validated commutative assertions,
\* not mutable predicates/quotas. A multi-owner group is a singleton transaction.
Good(g) == {t \in Members[g] : Valid[t]}
Bad(g) == Members[g] \ Good(g)
GroupOwners(g) == UNION {Participants[t] : t \in Good(g)}
Rank(t) == CHOOSE i \in 1..Len(TxnOrder) : TxnOrder[i] = t
LocalOffset(g, t, o) == Cardinality({u \in Good(g) : o \in Participants[u] /\ Rank(u) <= Rank(t)})
LastRevision(g, o) == Cardinality({u \in Good(g) : o \in Participants[u]})
ASSUME BatchTyping ==
  /\ IsFiniteSet(Owners) /\ IsFiniteSet(Txns) /\ IsFiniteSet(Groups)
  /\ "free" \notin Groups /\ "root" \notin Groups
  /\ Members \in [Groups -> (SUBSET Txns) \ {{}}]
  /\ UNION {Members[g] : g \in Groups} = Txns
  /\ \A g, h \in Groups : g # h => Members[g] \cap Members[h] = {}
  /\ Valid \in [Txns -> BOOLEAN]
  /\ AdmissionHome \in [Groups -> Owners]
  /\ \A g \in Groups : Cardinality(GroupOwners(g)) > 1 => Cardinality(Members[g]) = 1
  /\ TxnOrder \in Seq(Txns) /\ {TxnOrder[i] : i \in 1..Len(TxnOrder)} = Txns
  /\ Len(TxnOrder) = Cardinality(Txns)
  /\ OwnerOrder \in Seq(Owners) /\ {OwnerOrder[i] : i \in 1..Len(OwnerOrder)} = Owners
  /\ Len(OwnerOrder) = Cardinality(Owners)
  /\ MaxActive \in Nat \ {0} /\ MaxEpoch \in Nat /\ MaxCrashes \in Nat
  /\ {GuardEpoch, GuardClosed, GuardReply, GuardIndependent, GuardExactlyOnce, GuardPublishReplay, Incremental} \subseteq BOOLEAN

VARIABLE c
allvars == <<s, c>>
Phases == {"new", "admitted", "prepared", "decided", "published", "released", "done", "rejected"}
Active == {g \in Groups : c.phase[g] \notin {"new", "done", "rejected"}}
ActiveAt(home) == {g \in Active : AdmissionHome[g] = home}
Protected == {"prepared", "decided", "published"}
Actors == Groups \cup {"root"}
NextOwner(g) == IF c.lockIndex[g] <= Len(OwnerOrder) THEN OwnerOrder[c.lockIndex[g]] ELSE "none"
AllGates(g) == \A o \in GroupOwners(g) : c.gate[o] = g
Released(g) == \A o \in GroupOwners(g) : c.gate[o] # g
Applied(g) == \A o \in GroupOwners(g) : Good(g) \cap OwnerTxns(o) \subseteq s.effects[o]
ApplyConfirmed(g) == \A o \in GroupOwners(g) : c.delivery[g][o] \in {"confirmed", "finished", "witnessed"}
Witnessed(g) == \A o \in GroupOwners(g) : c.delivery[g][o] = "witnessed"
EpochMatches(g) == \A o \in GroupOwners(g) : c.planEpoch[g][o] = c.epoch[o]

Init ==
  /\ CoreInit
  /\ c = [phase |-> [g \in Groups |-> "new"], epoch |-> [o \in Owners |-> 0],
           planEpoch |-> [g \in Groups |-> [o \in Owners |-> 0]],
           gate |-> [o \in Owners |-> "free"], lockIndex |-> [g \in Groups |-> 1],
           revision |-> [t \in Txns |-> [o \in Owners |-> 0]], frontier |-> [o \in Owners |-> 0],
           target |-> [g \in Groups |-> [o \in Owners |-> 0]], ownerFrontier |-> [o \in Owners |-> 0],
           delivery |-> [g \in Groups |-> [o \in Owners |-> "none"]],
           issuedPublish |-> {}, rootPublished |-> {},
           counts |-> [o \in Owners |-> [t \in Txns |-> 0]], views |-> [o \in Owners |-> {}],
           up |-> Actors, crashesLeft |-> MaxCrashes,
           queryPhase |-> "idle", queryCut |-> [o \in Owners |-> 0],
           queryPublished |-> {}, queryAcked |-> {}, scanned |-> {}, seen |-> [o \in Owners |-> {}]]

Admit(g) ==
  /\ g \in c.up /\ c.phase[g] = "new" /\ Cardinality(ActiveAt(AdmissionHome[g])) < MaxActive
  /\ c' = [c EXCEPT !.phase[g] = "admitted", !.planEpoch[g] = c.epoch]
  /\ UNCHANGED s
Reject(g) ==
  /\ g \in c.up /\ c.phase[g] = "new" /\ Cardinality(ActiveAt(AdmissionHome[g])) >= MaxActive
  /\ c' = [c EXCEPT !.phase[g] = "rejected"]
  /\ UNCHANGED s
Refresh(g) ==
  /\ g \in c.up /\ c.phase[g] = "admitted" /\ ~EpochMatches(g)
  /\ c' = [c EXCEPT !.planEpoch[g] = c.epoch]
  /\ UNCHANGED s
Prepare(g) ==
  /\ g \in c.up /\ c.phase[g] = "admitted"
  /\ (~GuardEpoch \/ EpochMatches(g))
  /\ c' = [c EXCEPT !.phase[g] = "prepared"]
  /\ UNCHANGED s
Acquire(g) ==
  /\ g \in c.up /\ c.phase[g] = "prepared" /\ c.lockIndex[g] <= Len(OwnerOrder)
  /\ LET o == NextOwner(g) IN
       /\ (o \notin GroupOwners(g) \/ c.gate[o] = "free" \/ c.gate[o] = g)
       /\ o \in GroupOwners(g)
       /\ c' = [c EXCEPT !.gate[o] = g]
  /\ UNCHANGED s
ConfirmGate(g) ==
  /\ g \in c.up /\ c.phase[g] = "prepared" /\ c.lockIndex[g] <= Len(OwnerOrder)
  /\ LET o == NextOwner(g) IN
       /\ (o \notin GroupOwners(g) \/ c.gate[o] = g)
       /\ c' = [c EXCEPT !.lockIndex[g] = @ + 1]
  /\ UNCHANGED s
DecideGroup(g) ==
  /\ g \in c.up /\ c.phase[g] = "prepared" /\ c.lockIndex[g] > Len(OwnerOrder) /\ AllGates(g)
  /\ IF GuardIndependent \/ Bad(g) = {} THEN Decide(Good(g), Bad(g)) ELSE Decide({}, Members[g])
  /\ c' = [c EXCEPT !.phase[g] = "decided",
                     !.target[g] = [o \in Owners |-> c.frontier[o] + LastRevision(g, o)],
                     !.revision = [t \in Txns |-> [o \in Owners |->
                       IF t \in Good(g) /\ o \in Participants[t]
                         THEN c.frontier[o] + LocalOffset(g, t, o)
                         ELSE c.revision[t][o]]]]
DeliverApply(g, o) ==
  /\ g \in c.up /\ c.phase[g] = "decided" /\ o \in GroupOwners(g) /\ c.gate[o] = g
  /\ (~GuardEpoch \/ EpochMatches(g))
  /\ c.delivery[g][o] \in {"none", "applied"}
  /\ Apply(o, Good(g) \cap OwnerTxns(o))
  /\ c' = [c EXCEPT !.delivery[g][o] = "applied", !.counts[o] = [t \in Txns |->
                       IF t \in Good(g) /\ o \in Participants[t]
                         THEN IF GuardExactlyOnce THEN 1 ELSE c.counts[o][t] + 1
                         ELSE c.counts[o][t]],
                     !.views[o] = IF Incremental THEN @ \cup (Good(g) \cap OwnerTxns(o))
                                  ELSE Good(g) \cap OwnerTxns(o)]
ConfirmApply(g, o) ==
  /\ g \in c.up /\ c.phase[g] = "decided" /\ o \in GroupOwners(g)
  /\ c.delivery[g][o] = "applied"
  /\ c' = [c EXCEPT !.delivery[g][o] = "confirmed"] /\ UNCHANGED s
FinishOwner(g, o) ==
  /\ g \in c.up /\ c.phase[g] = "decided" /\ o \in GroupOwners(g) /\ AllGates(g) /\ Applied(g)
  /\ c.delivery[g][o] = "confirmed" /\ ApplyConfirmed(g)
  /\ c' = [c EXCEPT !.delivery[g][o] = "finished", !.ownerFrontier[o] = c.target[g][o]]
  /\ UNCHANGED s
ConfirmOwner(g, o) ==
  /\ g \in c.up /\ c.phase[g] = "decided" /\ o \in GroupOwners(g)
  /\ c.delivery[g][o] = "finished"
  /\ c' = [c EXCEPT !.delivery[g][o] = "witnessed"] /\ UNCHANGED s
DispatchPublish(g) ==
  /\ g \in c.up /\ c.phase[g] = "decided" /\ AllGates(g) /\ Witnessed(g)
  /\ c' = [c EXCEPT !.issuedPublish = @ \cup {g}] /\ UNCHANGED s
PublishGroup(g, patch) ==
  /\ "root" \in c.up /\ g \in c.issuedPublish
  /\ patch \subseteq GroupOwners(g)
  /\ (GuardClosed => patch = GroupOwners(g))
  /\ Publish(Good(g))
  /\ c' = [c EXCEPT !.rootPublished = @ \cup {g}, !.frontier = [o \in Owners |->
                       IF o \notin patch THEN c.frontier[o]
                       ELSE IF ~GuardPublishReplay THEN c.frontier[o] + LastRevision(g, o)
                       ELSE IF c.target[g][o] > c.frontier[o] THEN c.target[g][o] ELSE c.frontier[o]]]
ConfirmPublication(g) ==
  /\ g \in c.up /\ c.phase[g] = "decided" /\ g \in c.rootPublished
  /\ c' = [c EXCEPT !.phase[g] = "published"] /\ UNCHANGED s
Release(g, o) ==
  /\ g \in c.up /\ c.phase[g] = "published" /\ o \in GroupOwners(g) /\ c.gate[o] = g
  /\ c' = [c EXCEPT !.gate[o] = "free"] /\ UNCHANGED s
FinishRelease(g) ==
  /\ g \in c.up /\ c.phase[g] = "published" /\ Released(g)
  /\ c' = [c EXCEPT !.phase[g] = "released"] /\ UNCHANGED s
Reply(g) ==
  /\ g \in c.up
  /\ IF GuardReply THEN c.phase[g] \in {"released", "done"} ELSE c.phase[g] \in {"decided", "released", "done"}
  /\ IF GuardReply THEN Acknowledge(Good(g)) ELSE s' = [s EXCEPT !.acked = @ \cup Good(g)]
  /\ c' = [c EXCEPT !.phase[g] = "done"]
LoseReply(g) ==
  /\ g \in c.up /\ c.phase[g] = "released"
  /\ c' = [c EXCEPT !.phase[g] = "done"] /\ UNCHANGED s

\* A topology operation may invalidate queued plans, not protected decisions.
\* This is the existing conservative fence, NOT live migration of a prepared write.
AdvanceEpoch(o) ==
  /\ c.epoch[o] < MaxEpoch /\ c.gate[o] = "free"
  /\ \A g \in Groups : c.phase[g] \in Protected => o \notin GroupOwners(g)
  /\ c' = [c EXCEPT !.epoch[o] = @ + 1] /\ UNCHANGED s
Crash(a) ==
  /\ a \in c.up /\ c.crashesLeft > 0
  /\ c' = [c EXCEPT !.up = @ \ {a}, !.crashesLeft = @ - 1] /\ UNCHANGED s
Recover(a) ==
  /\ a \notin c.up /\ c' = [c EXCEPT !.up = @ \cup {a}] /\ UNCHANGED s

Capture ==
  /\ "root" \in c.up /\ c.queryPhase = "idle"
  /\ c' = [c EXCEPT !.queryPhase = "captured", !.queryCut = c.frontier,
                     !.queryPublished = s.published, !.queryAcked = s.acked]
  /\ UNCHANGED s
Scan(o) ==
  /\ c.queryPhase = "captured" /\ o \notin c.scanned
  /\ c' = [c EXCEPT !.scanned = @ \cup {o}, !.seen[o] =
                     {t \in c.views[o] : c.revision[t][o] > 0 /\ c.revision[t][o] <= c.queryCut[o]}]
  /\ UNCHANGED s
FinishRead ==
  /\ c.queryPhase = "captured" /\ c.scanned = Owners
  /\ c' = [c EXCEPT !.queryPhase = "done"] /\ UNCHANGED s

GroupStep(g) ==
  \/ Admit(g) \/ Reject(g) \/ Refresh(g) \/ Prepare(g) \/ Acquire(g) \/ ConfirmGate(g) \/ DecideGroup(g)
  \/ (\E o \in Owners : DeliverApply(g, o) \/ ConfirmApply(g, o)
                       \/ FinishOwner(g, o) \/ ConfirmOwner(g, o) \/ Release(g, o))
  \/ DispatchPublish(g) \/ (\E patch \in SUBSET Owners : PublishGroup(g, patch))
  \/ ConfirmPublication(g) \/ FinishRelease(g) \/ Reply(g) \/ LoseReply(g)
Next ==
  \/ (\E g \in Groups : GroupStep(g))
  \/ (\E o \in Owners : AdvanceEpoch(o) \/ Scan(o))
  \/ (\E a \in Actors : Crash(a) \/ Recover(a))
  \/ Capture \/ FinishRead
Spec == Init /\ [][Next]_allvars
FairSpec == Spec /\ (\A g \in Groups : WF_allvars(GroupStep(g)))
                 /\ (\A a \in Actors : WF_allvars(Recover(a)))
Settled == \A g \in Groups : c.phase[g] \in {"done", "rejected"}
EventuallySettled == <>Settled

BatchType ==
  /\ CoreType
  /\ c.phase \in [Groups -> Phases] /\ c.epoch \in [Owners -> 0..MaxEpoch]
  /\ c.planEpoch \in [Groups -> [Owners -> 0..MaxEpoch]]
  /\ c.gate \in [Owners -> (Groups \cup {"free"})]
  /\ c.lockIndex \in [Groups -> 1..(Len(OwnerOrder)+1)]
  /\ c.revision \in [Txns -> [Owners -> Nat]] /\ c.frontier \in [Owners -> Nat]
  /\ c.target \in [Groups -> [Owners -> Nat]] /\ c.ownerFrontier \in [Owners -> Nat]
  /\ c.delivery \in [Groups -> [Owners -> {"none", "applied", "confirmed", "finished", "witnessed"}]]
  /\ c.issuedPublish \subseteq Groups /\ c.rootPublished \subseteq c.issuedPublish
  /\ c.counts \in [Owners -> [Txns -> Nat]] /\ c.views \in [Owners -> SUBSET Txns]
  /\ c.up \subseteq Actors /\ c.crashesLeft \in 0..MaxCrashes
  /\ c.queryPhase \in {"idle", "captured", "done"}
  /\ c.queryCut \in [Owners -> Nat] /\ c.queryPublished \subseteq Txns /\ c.queryAcked \subseteq Txns
  /\ c.scanned \subseteq Owners /\ c.seen \in [Owners -> SUBSET Txns]
AdmissionBound == \A home \in Owners : Cardinality(ActiveAt(home)) <= MaxActive
DecisionsIndependent ==
  /\ \A t \in s.committed : Valid[t]
  /\ \A t \in s.aborted : ~Valid[t]
NoDuplicateEffects == \A o \in Owners, t \in Txns : c.counts[o][t] <= 1
ProjectionMatchesFacts == c.views = s.effects
FrontierWithinOwner == \A o \in Owners : c.frontier[o] <= c.ownerFrontier[o]
PreparedEpochsCurrent == \A g \in Groups : c.phase[g] \in Protected => EpochMatches(g)
CutMatchesPublication == \A o \in Owners :
  {t \in OwnerTxns(o) : c.revision[t][o] > 0 /\ c.revision[t][o] <= c.frontier[o]} = s.visible[o]
QueryMatchesSnapshot == c.queryPhase # "done" \/
  (\A o \in Owners : c.seen[o] = c.queryPublished \cap OwnerTxns(o))
QueryIsAtomic == c.queryPhase # "done" \/
  (\A t \in Txns : (\E o \in Owners : t \in c.seen[o]) => (\A o \in Participants[t] : t \in c.seen[o]))
QueryIncludesAcknowledged == c.queryPhase = "idle" \/ c.queryAcked \subseteq c.queryPublished
BatchSafety == /\ CoreSafety /\ AdmissionBound /\ DecisionsIndependent /\ NoDuplicateEffects
               /\ ProjectionMatchesFacts /\ FrontierWithinOwner /\ PreparedEpochsCurrent /\ CutMatchesPublication
               /\ QueryMatchesSnapshot /\ QueryIsAtomic /\ QueryIncludesAcknowledged

\* Deliberately false invariants: TLC must find these reachability witnesses.
NoMixedBatch == ~ (\E g \in Groups : Cardinality(Good(g)) >= 2 /\ Bad(g) # {}
  /\ Good(g) \subseteq s.published /\ Bad(g) \subseteq s.aborted /\ c.phase[g] = "done")
NoDisjointExecution == ~ (\E g, h \in Groups : g # h
  /\ c.phase[g] = "decided" /\ c.phase[h] = "decided"
  /\ GroupOwners(g) # {} /\ GroupOwners(h) # {}
  /\ GroupOwners(g) \cap GroupOwners(h) = {})
NoAdmissionRejection == \A g \in Groups : c.phase[g] # "rejected"
NoAggregateScaling == Cardinality(Active) <= MaxActive
NoLostReply == \A g \in Groups : c.phase[g] = "done" => Good(g) \subseteq s.acked
NoUnconfirmedPublication == \A g \in c.rootPublished : c.phase[g] # "decided"
=============================================================================

------------------------------ MODULE ReadVectorRecovery ------------------------------
EXTENDS Naturals, FiniteSets, Sequences, TLC

CONSTANTS Owners, Txns
ASSUME
  /\ Owners = {"A", "B"}
  /\ Txns = {"T0", "T1", "T2", "T3"}

OwnerOrder == <<"A", "B">>
Participants ==
    [t \in Txns |->
        IF t = "T0" THEN {"A", "B"}
        ELSE IF t = "T1" THEN {"A"}
        ELSE IF t = "T2" THEN {"B"}
        ELSE {"A"}]

VARIABLES frontier, gate, lockIndex, prepared, committed, revision,
          published, acked, leaseActive, queryPhase, queryCut,
          snapshotPublished, snapshotAcked, scanned, seen

vars == <<frontier, gate, lockIndex, prepared, committed, revision,
          published, acked, leaseActive, queryPhase, queryCut,
          snapshotPublished, snapshotAcked, scanned, seen>>

TypeOK ==
    /\ frontier \in [Owners -> Nat]
    /\ gate \in [Owners -> (Txns \cup {"free"})]
    /\ lockIndex \in [Txns -> 1..(Len(OwnerOrder) + 1)]
    /\ prepared \in [Txns -> SUBSET Owners]
    /\ committed \in [Txns -> SUBSET Owners]
    /\ revision \in [Txns -> [Owners -> Nat]]
    /\ published \subseteq Txns
    /\ acked \subseteq Txns
    /\ leaseActive \in BOOLEAN
    /\ queryPhase \in {"idle", "captured", "done"}
    /\ queryCut \in [Owners -> Nat]
    /\ snapshotPublished \subseteq Txns
    /\ snapshotAcked \subseteq Txns
    /\ scanned \subseteq Owners
    /\ seen \in [Owners -> SUBSET Txns]

NextOwner(t) == IF lockIndex[t] <= Len(OwnerOrder) THEN OwnerOrder[lockIndex[t]] ELSE "none"
AllGates(t) == \A o \in Participants[t] : gate[o] = t
AllRevisionsAssigned(t) == \A o \in Participants[t] : revision[t][o] > 0
Released(t) == \A o \in Participants[t] : gate[o] # t
Finalizing(t) == AllGates(t) /\ t \notin published

Crosses(t, v) ==
    \E o \in Participants[t] : revision[t][o] > 0 /\ revision[t][o] <= v[o]
Covers(t, v) ==
    \A o \in Participants[t] : revision[t][o] > 0 /\ revision[t][o] <= v[o]
Closed(v, committedSet) ==
    \A t \in Txns : Crosses(t, v) => (t \in committedSet /\ Covers(t, v))

ClosedFrontier == Closed(frontier, published)

PublishedAfterAllEffectsAndRevisions ==
    \A t \in published :
        /\ prepared[t] = Participants[t]
        /\ committed[t] = Participants[t]
        /\ AllRevisionsAssigned(t)

CommitOnlyAfterPrepareAndFence ==
    \A t \in Txns : committed[t] # {} =>
        /\ prepared[t] = Participants[t]
        /\ (t \in published \/ (AllGates(t) /\ AllRevisionsAssigned(t)))

UnpublishedRevisionIsNext ==
    \A t \in Txns :
        \A o \in Participants[t] :
            revision[t][o] > 0 /\ t \notin published => revision[t][o] = frontier[o] + 1

GateHasValidOwner ==
    \A o \in Owners :
        gate[o] # "free" => o \in Participants[gate[o]]

GateRequiresPrepared ==
    \A o \in Owners :
        gate[o] # "free" => prepared[gate[o]] = Participants[gate[o]]

UnpublishedRevisionsRemainFenced ==
    \A t \in Txns :
        (\E o \in Participants[t] : revision[t][o] > 0) /\ t \notin published
        => AllGates(t)

NoOverlappingFinalizers ==
    \A t1, t2 \in Txns :
        t1 # t2 /\ Finalizing(t1) /\ Finalizing(t2)
        => Participants[t1] \cap Participants[t2] = {}

DisjointFinalizersExist ==
    \E t1, t2 \in Txns :
        t1 # t2 /\ Finalizing(t1) /\ Finalizing(t2)
        /\ Participants[t1] \cap Participants[t2] = {}
NoDisjointFinalizers == ~DisjointFinalizersExist
NoLeaseDuringFinalization ==
    ~(leaseActive /\ \E t \in Txns : Finalizing(t))

AckOnlyAfterPublicationAndRelease ==
    \A t \in acked : t \in published /\ Released(t)

LeaseRegistrationMatchesQuery ==
    /\ (queryPhase = "idle" => ~leaseActive)
    /\ (queryPhase = "captured" => leaseActive)
    /\ (queryPhase = "done" => ~leaseActive)

CapturedCutClosed ==
    queryPhase = "idle" \/ Closed(queryCut, snapshotPublished)

CapturedAckedWritesIncluded ==
    queryPhase = "idle"
    \/ \A t \in snapshotAcked :
        /\ t \in snapshotPublished
        /\ \A o \in Participants[t] :
            revision[t][o] > 0 /\ revision[t][o] <= queryCut[o]

QueryResultsMatchSnapshot ==
    queryPhase # "done"
    \/ \A o \in Owners :
        seen[o] = {t \in snapshotPublished :
            o \in Participants[t] /\ revision[t][o] <= queryCut[o]}

QueryIsAtomic ==
    queryPhase # "done"
    \/ \A t \in Txns :
        (\E o \in Participants[t] : t \in seen[o])
        => \A o \in Participants[t] : t \in seen[o]

\* Poneglyph's MAV+ candidate: atomic query cuts, a globally monotonic
\* frontier, and inclusion of every acknowledged write in a later cut.
MAVPlusSafety ==
    /\ ClosedFrontier
    /\ CapturedCutClosed
    /\ CapturedAckedWritesIncluded
    /\ QueryIsAtomic
    /\ AckOnlyAfterPublicationAndRelease
    /\ LeaseRegistrationMatchesQuery

Init ==
    /\ frontier = [o \in Owners |-> 0]
    /\ gate = [o \in Owners |-> "free"]
    /\ lockIndex = [t \in Txns |-> 1]
    /\ prepared = [t \in Txns |-> Participants[t]]
    /\ committed = [t \in Txns |-> {}]
    /\ revision = [t \in Txns |-> [o \in Owners |-> 0]]
    /\ published = {}
    /\ acked = {}
    /\ leaseActive = FALSE
    /\ queryPhase = "idle"
    /\ queryCut = [o \in Owners |-> 0]
    /\ snapshotPublished = {}
    /\ snapshotAcked = {}
    /\ scanned = {}
    /\ seen = [o \in Owners |-> {}]

\* Every transaction has a durable irrevocable decision and entity reservations
\* before entering this model. `prepared` is hidden participant staging. The
\* publication gates are acquired only after all prepares; commit applies the
\* final owner revision while gates are held. Publish is one coordinator-local
\* atomic merge of all participating revisions plus the transaction marker.
\*
\* Each action below is a durable idempotent boundary. A crash is stuttering;
\* after restart a worker/alarm chooses the next action from these persisted
\* variables. Gate acquisition and ledger confirmation are separate actions so
\* an uncertain response can be retried safely. Query capture copies the cached
\* vector and registers its pin in one coordinator action; writers never test
\* leaseActive. The model has no history-pruning action, abort path, topology
\* operation, or unbounded actor failure.

SkipNonParticipantGate(t) ==
    /\ t \notin published
    /\ prepared[t] = Participants[t]
    /\ lockIndex[t] <= Len(OwnerOrder)
    /\ NextOwner(t) \notin Participants[t]
    /\ lockIndex' = [lockIndex EXCEPT ![t] = @ + 1]
    /\ UNCHANGED <<frontier, gate, prepared, committed, revision, published,
                   acked, leaseActive, queryPhase, queryCut, snapshotPublished,
                   snapshotAcked, scanned, seen>>

AcquireGate(t) ==
    LET o == NextOwner(t) IN
    /\ t \notin published
    /\ prepared[t] = Participants[t]
    /\ lockIndex[t] <= Len(OwnerOrder)
    /\ o \in Participants[t]
    /\ gate[o] = "free"
    /\ gate' = [gate EXCEPT ![o] = t]
    /\ UNCHANGED <<frontier, lockIndex, prepared, committed, revision,
                   published, acked, leaseActive, queryPhase, queryCut,
                   snapshotPublished, snapshotAcked, scanned, seen>>

ConfirmGate(t) ==
    LET o == NextOwner(t) IN
    /\ t \notin published
    /\ prepared[t] = Participants[t]
    /\ lockIndex[t] <= Len(OwnerOrder)
    /\ o \in Participants[t]
    /\ gate[o] = t
    /\ lockIndex' = [lockIndex EXCEPT ![t] = @ + 1]
    /\ UNCHANGED <<frontier, gate, prepared, committed, revision, published,
                   acked, leaseActive, queryPhase, queryCut, snapshotPublished,
                   snapshotAcked, scanned, seen>>

AssignRevision(t, o) ==
    /\ t \notin published
    /\ lockIndex[t] = Len(OwnerOrder) + 1
    /\ prepared[t] = Participants[t]
    /\ AllGates(t)
    /\ o \in Participants[t]
    /\ revision[t][o] = 0
    /\ revision' = [revision EXCEPT ![t][o] = frontier[o] + 1]
    /\ UNCHANGED <<frontier, gate, lockIndex, prepared, committed, published,
                   acked, leaseActive, queryPhase, queryCut, snapshotPublished,
                   snapshotAcked, scanned, seen>>

CommitParticipant(t, o) ==
    /\ t \notin published
    /\ prepared[t] = Participants[t]
    /\ AllGates(t)
    /\ AllRevisionsAssigned(t)
    /\ o \in Participants[t]
    /\ o \notin committed[t]
    /\ committed' = [committed EXCEPT ![t] = @ \cup {o}]
    /\ UNCHANGED <<frontier, gate, lockIndex, prepared, revision, published,
                   acked, leaseActive, queryPhase, queryCut, snapshotPublished,
                   snapshotAcked, scanned, seen>>

Publish(t) ==
    /\ t \notin published
    /\ lockIndex[t] = Len(OwnerOrder) + 1
    /\ AllGates(t)
    /\ prepared[t] = Participants[t]
    /\ committed[t] = Participants[t]
    /\ AllRevisionsAssigned(t)
    /\ frontier' = [o \in Owners |->
          IF o \in Participants[t] THEN revision[t][o] ELSE frontier[o]]
    /\ published' = published \cup {t}
    /\ UNCHANGED <<gate, lockIndex, prepared, committed, revision, acked,
                   leaseActive, queryPhase, queryCut, snapshotPublished,
                   snapshotAcked, scanned, seen>>

ReleaseGate(t, o) ==
    /\ t \in published
    /\ o \in Participants[t]
    /\ gate[o] = t
    /\ gate' = [gate EXCEPT ![o] = "free"]
    /\ UNCHANGED <<frontier, lockIndex, prepared, committed, revision,
                   published, acked, leaseActive, queryPhase, queryCut,
                   snapshotPublished, snapshotAcked, scanned, seen>>

Acknowledge(t) ==
    /\ t \in published
    /\ Released(t)
    /\ t \notin acked
    /\ acked' = acked \cup {t}
    /\ UNCHANGED <<frontier, gate, lockIndex, prepared, committed, revision,
                   published, leaseActive, queryPhase, queryCut,
                   snapshotPublished, snapshotAcked, scanned, seen>>

CaptureReadLease ==
    /\ queryPhase = "idle"
    /\ queryCut' = frontier
    /\ snapshotPublished' = published
    /\ snapshotAcked' = acked
    /\ leaseActive' = TRUE
    /\ queryPhase' = "captured"
    /\ UNCHANGED <<frontier, gate, lockIndex, prepared, committed, revision,
                   published, acked, scanned, seen>>

ScanOwner(o) ==
    /\ queryPhase = "captured"
    /\ leaseActive
    /\ o \in Owners \ scanned
    /\ seen' = [seen EXCEPT ![o] = @ \cup
          {t \in snapshotPublished :
              o \in Participants[t] /\ revision[t][o] <= queryCut[o]}]
    /\ scanned' = scanned \cup {o}
    /\ UNCHANGED <<frontier, gate, lockIndex, prepared, committed, revision,
                   published, acked, leaseActive, queryPhase, queryCut,
                   snapshotPublished, snapshotAcked>>

ReleaseReadLease ==
    /\ queryPhase = "captured"
    /\ scanned = Owners
    /\ leaseActive
    /\ leaseActive' = FALSE
    /\ queryPhase' = "done"
    /\ UNCHANGED <<frontier, gate, lockIndex, prepared, committed, revision,
                   published, acked, queryCut, snapshotPublished,
                   snapshotAcked, scanned, seen>>

ProtocolNext ==
    \/ \E t \in Txns : SkipNonParticipantGate(t)
    \/ \E t \in Txns : AcquireGate(t)
    \/ \E t \in Txns : ConfirmGate(t)
    \/ \E t \in Txns, o \in Owners : AssignRevision(t, o)
    \/ \E t \in Txns, o \in Owners : CommitParticipant(t, o)
    \/ \E t \in Txns : Publish(t)
    \/ \E t \in Txns, o \in Owners : ReleaseGate(t, o)
    \/ \E t \in Txns : Acknowledge(t)

ReadNext ==
    \/ CaptureReadLease
    \/ \E o \in Owners : ScanOwner(o)
    \/ ReleaseReadLease

NoProtocolDeadlock == acked = Txns \/ ENABLED ProtocolNext
Next == ProtocolNext \/ ReadNext

Spec == Init /\ [][Next]_vars

ProtocolFairness ==
    /\ \A t \in Txns : WF_vars(SkipNonParticipantGate(t))
    /\ \A t \in Txns : WF_vars(AcquireGate(t))
    /\ \A t \in Txns : WF_vars(ConfirmGate(t))
    /\ \A t \in Txns, o \in Owners : WF_vars(AssignRevision(t, o))
    /\ \A t \in Txns, o \in Owners : WF_vars(CommitParticipant(t, o))
    /\ \A t \in Txns : WF_vars(Publish(t))
    /\ \A t \in Txns, o \in Owners : WF_vars(ReleaseGate(t, o))
    /\ \A t \in Txns : WF_vars(Acknowledge(t))

FairSpec == Spec /\ ProtocolFairness
EventuallyAcknowledged == <> (acked = Txns)

FrontierNondecreasing ==
    \A o \in Owners : frontier[o] <= frontier'[o]
FrontierMonotonic == [] [FrontierNondecreasing]_vars
MAVPlus == [] MAVPlusSafety /\ FrontierMonotonic
MAVPlusProgress == EventuallyAcknowledged

================================================================================
